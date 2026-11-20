//! thoth-ocr: reads the text of one image or PDF per run (ADR-0055, protocol 1).
//!
//! thoth-ocr serve --models <dir> --preset openthai|pp5    one job: request on stdin, JSON lines on stdout
//! thoth-ocr --version
//!
//! ONNX Runtime is loaded from ORT_DYLIB_PATH. The host gives the bytes on stdin; this program never opens a document.

mod pdf;
mod protocol;
mod textcheck;

use oar_ocr::oarocr::{OAROCR, OAROCRBuilder};
use protocol::{ProtoError, Request};
use serde_json::json;
use std::io::{BufWriter, Write};
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

const PROTOCOL: u32 = 1;
const MAX_PIXELS: u64 = 40_000_000;
/// PDF pages are rendered at twice their size (144 dpi) for OCR, as measured in Phase 0.
const PDF_SCALE: f32 = 2.0;

/// A failed job: the protocol's error code and a message for the log (never document text).
struct Fail(&'static str, String);

impl<E: std::fmt::Display> From<E> for Fail {
    fn from(e: E) -> Self {
        Fail("failed", e.to_string())
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["--version"] => {
            println!("thoth-ocr {} protocol {PROTOCOL}", env!("CARGO_PKG_VERSION"));
            0
        }
        ["serve", "--models", dir, "--preset", preset] => {
            let mut out = BufWriter::new(std::io::stdout().lock());
            let res = serve(Path::new(dir), preset, &mut std::io::stdin().lock(), &mut out);
            let code = match res {
                Ok(()) => {
                    let _ = writeln!(out, "{}", json!({"done": true}));
                    0
                }
                Err(Fail(kind, message)) => {
                    let _ = writeln!(out, "{}", json!({"error": kind, "message": message}));
                    1
                }
            };
            let _ = out.flush();
            code
        }
        _ => {
            eprintln!("usage: thoth-ocr serve --models <dir> --preset openthai|pp5 | thoth-ocr --version");
            2
        }
    };
    std::process::exit(code);
}

fn serve(models: &Path, preset: &str, input: &mut impl std::io::Read, out: &mut impl Write) -> Result<(), Fail> {
    let request = protocol::read_request(input).map_err(|e| match e {
        ProtoError::TooLarge => Fail("too-large", "the file is over the size limit".into()),
        ProtoError::BadRequest(m) => Fail("bad-request", m),
    })?;
    // The input is checked before the models load, so a bad file costs no model load.
    match request {
        Request::Image(bytes) => {
            check_size(&bytes).map_err(|kind| Fail(kind, "the image can't be read or is too large".into()))?;
            let img = image::load_from_memory(&bytes).map_err(|e| Fail("bad-image", e.to_string()))?.to_rgb8();
            let ocr = build(models, preset)?;
            page_line(out, 1, 1, "ocr", &read(&ocr, img)?)?;
        }
        Request::Pdf { bytes, max_pages } => {
            let doc = pdf::open(bytes).map_err(|m| Fail("bad-pdf", m))?;
            let ocr = build(models, preset)?;
            let pages = doc.pages().len().min(max_pages);
            for i in 0..pages {
                let text = pdf::text_layer(&doc, i);
                if textcheck::check(&text).verdict() != "broken" && !text.trim().is_empty() {
                    page_line(out, i + 1, pages, "text", &text)?;
                } else {
                    let img = pdf::render(&doc, i, PDF_SCALE, MAX_PIXELS).map_err(|m| Fail("bad-pdf", m))?;
                    page_line(out, i + 1, pages, "ocr", &read(&ocr, img)?)?;
                }
            }
        }
    }
    Ok(())
}

fn build(dir: &Path, preset: &str) -> Result<OAROCR, Fail> {
    #[cfg(feature = "tract")]
    ort::set_api(ort_tract::api());
    #[cfg(not(feature = "tract"))]
    {
        // Loaded explicitly so a missing or wrong library is a plain error, not a panic inside ort.
        let lib = std::env::var_os("ORT_DYLIB_PATH").ok_or_else(|| Fail("failed", "ORT_DYLIB_PATH is not set".into()))?;
        ort::init_from(lib)?.commit();
    }
    let builder = match preset {
        "openthai" => OAROCRBuilder::openthai_from_dir(dir),
        "pp5" => OAROCRBuilder::new(dir.join("det.onnx"), dir.join("rec.onnx"), dir.join("dict.txt")),
        _ => return Err(Fail("bad-request", format!("unknown preset {preset}"))),
    };
    // tract's detectors take a fixed square: pad the long side, as Phase 0 measured.
    #[cfg(feature = "tract")]
    let builder = builder.detection_preprocessing(oar_ocr::oarocr::DetectionPreprocessing::PaddedLongSide);
    Ok(builder.build()?)
}

/// Pad to a white square at the top left, so the padded-long-side detector input is the square tract's detector expects.
/// shortcut: pages under ~290 px get a smaller detector input and fail on tract; upscale them first if that matters.
#[cfg(feature = "tract")]
fn pad_square(img: image::RgbImage) -> image::RgbImage {
    let side = img.width().max(img.height());
    let mut out = image::RgbImage::from_pixel(side, side, image::Rgb([255; 3]));
    image::imageops::replace(&mut out, &img, 0, 0);
    out
}

fn read(ocr: &OAROCR, img: image::RgbImage) -> Result<String, Fail> {
    #[cfg(feature = "tract")]
    let img = pad_square(img);
    let (page, rows) = ocr.predict_with_rows(vec![img])?.pop().ok_or_else(|| Fail("failed", "no result".into()))?;
    Ok(page.text_by_rows(&rows)?)
}

fn page_line(out: &mut impl Write, page: usize, pages: usize, source: &str, text: &str) -> Result<(), Fail> {
    writeln!(out, "{}", json!({"page": page, "pages": pages, "source": source, "text": nfc(text)}))?;
    // Each finished page reaches the host at once: its timeout counts from the last page.
    out.flush()?;
    Ok(())
}

/// NFC, so a vowel or tone mark is stored the same way every time; rows stay one per line.
fn nfc(text: &str) -> String {
    text.nfc().collect()
}

/// `Err("too-large")` above 40 megapixels, read from the header only; `Err("bad-image")` for what isn't a PNG or JPEG.
fn check_size(bytes: &[u8]) -> Result<(), &'static str> {
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().map_err(|_| "bad-image")?;
    let (w, h) = reader.into_dimensions().map_err(|_| "bad-image")?;
    if w as u64 * h as u64 > MAX_PIXELS { Err("too-large") } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nfc_and_rows() {
        // Canonical order: a tone mark typed before the vowel below it is reordered (ccc 103 before 107); rows stay.
        assert_eq!(nfc("ก\u{0E48}\u{0E38}\nสอง"), "ก\u{0E38}\u{0E48}\nสอง");
        assert_eq!(nfc("e\u{0301} x"), "\u{e9} x");
    }

    /// A PNG of the given size with only its IHDR and an empty IDAT: no pixels to decode.
    fn png_header(w: u32, h: u32) -> Vec<u8> {
        fn crc(data: &[u8]) -> u32 {
            let mut c = !0u32;
            for b in data {
                c ^= *b as u32;
                for _ in 0..8 {
                    c = if c & 1 == 1 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
                }
            }
            !c
        }
        fn chunk(out: &mut Vec<u8>, kind: &[u8], data: &[u8]) {
            out.extend_from_slice(&(data.len() as u32).to_be_bytes());
            let body: Vec<u8> = kind.iter().chain(data).copied().collect();
            out.extend_from_slice(&body);
            out.extend_from_slice(&crc(&body).to_be_bytes());
        }
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 0, 0, 0, 0]);
        chunk(&mut out, b"IHDR", &ihdr);
        chunk(&mut out, b"IDAT", &[]);
        out
    }

    #[test]
    fn refuses_more_than_40_megapixels() {
        assert_eq!(check_size(&png_header(8000, 6000)), Err("too-large"));
        assert_eq!(check_size(&png_header(6000, 6000)), Ok(()));
        assert_eq!(check_size(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), Err("bad-image"));
    }
}
