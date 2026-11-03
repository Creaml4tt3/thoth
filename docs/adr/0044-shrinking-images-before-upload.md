# ADR-0044: Shrinking images before they are uploaded to a workspace

- **Status:** Proposed, not scheduled. Written for later; nothing is built.
- **Date:** 2026-11-02
- **Deciders:** owner (asked for the research and for this record); the rules below are a proposal to review before
  building
- **Builds on:** ADR-0028 (images in pages)

## Context

ADR-0028 uploads a workspace image as the user's file, byte for byte, as an attachment; the page links it as
`thoth:attachment/<id>`. The server stores each distinct file once (by content hash), on disk (`BLOB_STORE=fs`, the
self-hosting default) or in PostgreSQL (`BLOB_STORE=postgres`, the demo server).

The demo server's limits make image size matter: 4 MB per file (Vercel refuses larger request bodies) and 20 MB of
attachments per workspace. A phone photo is often 3 to 8 MB and 4,000 px wide, so one photo can be refused, and a
handful can fill a workspace. Large images also make shared pages slow to open.

The owner asked whether images could be compressed before they are stored and decompressed by the client. Measured on
2026-11-02 with images from the website:

| File | Original | gzip -9 / zstd -19 (lossless, any file) | WebP quality 80 | WebP lossless |
| --- | ---: | ---: | ---: | ---: |
| PNG picture (1200 × 630) | 1,058 KB | 1,058 KB (0%) | 62 KB (−94%) | 730 KB (−31%) |
| JPEG photo | 42 KB | 30 KB (−28%) | 16 KB (−61%) | not measured |
| BMP (uncompressed) | 2,268 KB | 1,347 KB (−41%) | 62 KB (−97%) | not measured |

PNG, JPEG, WebP, AVIF and HEIC are already compressed, so general-purpose compression gains almost nothing on them;
the JPEG's 28% is unusual (most photos gain 0 to 3%). PostgreSQL already compresses large `bytea` values itself
(TOAST) and skips data that does not compress. Re-encoding is where the size goes.

## Decision (proposed)

1. **Shrink in the client, before upload; the server does not change.** The desktop app and the web client re-encode
   an image before `uploadAttachment`. The server stores what it receives, exactly as now. No protocol change, no new
   capability, no migration: an older client uploads originals, and every client already shows WebP.
2. **Only images added to a workspace page in the editor** (ADR-0028 rule 6: `/` Image, paste, drop). The Private
   Space is not touched: an image there is the user's own file next to the page, and it stays exactly as they put it.
   Transfers between spaces copy bytes as they are (see Open questions).
3. **What is converted:**
   - **Photos** (JPEG, and HEIC where it can be decoded): to lossy WebP at quality 80, longest side at most 2,560 px.
   - **PNG and BMP:** to *lossless* WebP, never lossy and never resized, so screenshots of text, diagrams and pixel
     art stay sharp. Kept only if at least 20% smaller.
   - **Left as they are:** files under 300 KB, GIF (often animated), SVG, ICO, WebP and AVIF already, and anything the
     client cannot decode.
   - **The smaller one wins:** if the result is not smaller than the original, the original is uploaded.
4. **Orientation and metadata.** The photo's orientation tag is applied to the pixels first, then all metadata is
   dropped: GPS location, camera, time. Colours are converted to sRGB if the image has another profile (to verify:
   what each encoder does with profiles).
5. **A way out.** Settings → Editor gets "Shrink photos before uploading to a workspace", on by default. Off uploads
   originals, as today. The upload message says what happened ("Uploaded photo.webp, 6.1 MB → 480 KB").
6. **Names.** The attachment keeps the original file name with the new extension (`IMG_2041.HEIC` →
   `IMG_2041.webp`). The alt text still comes from the name (ADR-0028).
7. **Limits stay where they are.** The editor's 20 MB limit is checked on the original (so a 15 MB photo can be shrunk
   and then fit the demo server's 4 MB); the server's own limits are checked on what is uploaded.
8. **Where the encoder runs** (to choose when building, after checking each platform):
   - Web client: the browser's canvas WebP encoder (`OffscreenCanvas.convertToBlob` with `type: "image/webp"`), if
     every supported browser encodes WebP rather than silently returning PNG; otherwise a WebAssembly encoder.
   - Desktop: the webviews differ (WKWebView, WebView2, WebKitGTK), so the Rust host may be the safer place (an image
     crate plus a WebP encoder), behind a new host call like `image.shrink`. HEIC decoding likely needs the host on
     macOS and may not be possible on Windows and Linux.
   - Encoding runs off the main thread (a worker or the host), with a progress state on the image placeholder.

## Consequences

- Positive: photos take 60 to 95% less space and upload and open faster; large phone photos stop being refused on the
  demo server; far more images fit in its 20 MB per workspace.
- Positive: location and camera data no longer leave the user's computer inside shared photos.
- Positive: the server, the protocol and older clients are unaffected.
- Negative: photos are lossy. Someone who needs the exact original must turn the setting off before uploading.
- Negative: a workspace image copied or moved to the Private Space is the shrunk version, not the user's original.
- Negative: two encoders to keep working (web and desktop), with different platform support; tests need real images
  per platform.
- Negative: converting a large photo takes a moment on slow machines before the upload starts.
- Negative: the same photo uploaded with and without the setting is stored twice (different bytes, different hashes).

## Alternatives considered

- **Lossless compression on the server (gzip, zstd), decompressed in the client.** Saves almost nothing on real
  images (measured above), duplicates what PostgreSQL already does, and adds a format to every client and to disk
  storage. Rejected.
- **Re-encoding on the server.** One place to maintain, but the original still travels the upload (so the 4 MB
  demo limit still refuses large photos), and it needs native image libraries and CPU time on serverless functions.
- **Keeping the original plus a smaller copy for display.** Best quality, but stores more than today, not less.
- **AVIF instead of WebP.** Smaller still, but slower to encode and with less encoder support in browsers; reconsider
  when building.
- **Shrinking Private Space images too.** Rejected: those are the user's own files in their own folder.

## Open questions

- Transfers from the Private Space into a workspace (ADR-0006): shrink the images they carry, under the same setting?
- Is quality 80 and 2,560 px right for the screens people use? Check with real photos before choosing.
- Attachments are still not tied to pages (ADR-0042 open question; ADR-0043): shrinking reduces what piles up but does
  not remove unused images.

## Spec references

ADR-0028 (images in pages), ADR-0014 (demo server limits), ADR-0006 (transfers).
