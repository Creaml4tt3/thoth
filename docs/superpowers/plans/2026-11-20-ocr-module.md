# OCR Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person downloads OCR from Settings → Modules, right-clicks an image in a page and gets its text ("Copy text" / "Insert text below"), and can import a PDF as a page; models update through a signed list without an app update.

**Architecture:** A new Rust program `thoth-ocr` (own Cargo workspace, `oar-ocr` on ONNX Runtime loaded at run time, `hayro` for PDFs) is built and uploaded to R2 by its own release workflow, never bundled in the installer. The host (`thoth-host`) gains a `modules` module: a store that downloads, checks, tests and switches the program, the ONNX Runtime library and the models; a runner that starts `thoth-ocr` per job as a supervised child over stdin/stdout; and new IPC commands. The webview gets a Settings → Modules section and two image menu items.

**Tech Stack:** Rust 2024 (`oar-ocr` =0.10.3, `ort` =2.0.0-rc.13 `load-dynamic`, `hayro` =0.9.0, `minisign-verify` 0.2.5, `flate2`, `sha2`, `ureq`), ONNX Runtime 1.28.0, React 19 + TypeScript, Vitest, GitHub Actions, Cloudflare R2.

**Spec:** `docs/architecture/ocr-plan.md` (§4, §5, §5a, §6 Phase 1–2) and `docs/adr/0055-ocr-module.md` (Accepted). Evidence and the code to start from: `tools/ocr-spike/` (`src/main.rs`, `src/pdf.rs`, `src/textcheck.rs`).

## Global Constraints

- Nothing is downloaded unless the person clicks Download (or turned on "Update OCR models automatically" and a model is already installed). No telemetry; images and PDFs never leave the computer.
- Program code (`thoth-ocr`, the ONNX Runtime library) changes only with an app update: its URLs and SHA-256 are compiled into the app (`runtime.json`). Models come from the signed list, with the compiled-in copy as fallback.
- Every downloaded file is checked against its SHA-256 **before** it is decompressed or used; staged in a `.part` folder; switched in by renaming a folder; the previous version is kept until the new one passes its test image.
- Files are hosted only on `https://download.thothnotes.com/modules/`. A list naming any other host is refused.
- Pins: `oar-ocr =0.10.3`, `ort =2.0.0-rc.13` (feature `load-dynamic`), `hayro =0.9.0`, ONNX Runtime **1.28.0** (the version `ort` rc.13 was built against).
- Choices: `fast` = OpenThai 2.1 Text (oar-ocr `openthai_from_dir` preset, `rec2` on), `second` = PP-OCRv5 mobile det + `th_PP-OCRv5_mobile_rec` (`OAROCRBuilder::new(det, rec, dict)`). Files and SHA-256 as in `tools/ocr-spike/models.lock`.
- Limits: image ≤ 20 MB and ≤ 40 megapixels; PDF ≤ 50 MB and ≤ 50 pages; one OCR job at a time; a job is killed after 60 s without a page finishing.
- Output text is NFC-normalized, one line per detected row, rows in `text_by_rows` order.
- Platforms: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`. Intel Mac uses our own ONNX Runtime build; if that build cannot be made to work, `x86_64-apple-darwin` ships the `tract` engine instead (ADR-0055 Decision 2) and the plan's PR says so.
- Desktop only. The web app shows neither the Settings section nor the image items.
- Every new string in `en.ts` and `th.ts`; Thai marked `// REVIEW`. CHANGELOG.md and CHANGELOG.th.md `[Unreleased]` get the same number of entries.
- Privacy notice and licence wording are drafts for the owner: mark them `<!-- REVIEW: owner -->`.
- `pnpm check` and `cargo clippy --workspace --all-targets -- -D warnings` / `cargo test --workspace` pass before each task's commit; `crates/thoth-ocr` passes its own `cargo clippy --all-targets -- -D warnings` and `cargo test`.

## Review Focus

- A download cut off half way, or a file with the wrong hash, leaves the installed version working and no `.part` folder behind on the next start. Test in Task 3.
- The person clicks Remove (or quits) while an OCR job runs: the child is killed, nothing half-written stays. Test in Task 4.
- A signed list whose newest model needs a newer app: the app keeps what it has and does not offer that model. Test in Task 3.
- An image that is not decodable (an SVG, a broken PNG) answers a plain error, never a crash or a hang. Test in Task 1 (program) and Task 4 (host maps it).
- "Copy text" before OCR is downloaded explains that and opens Settings → Modules, never downloads by itself. Test in Task 6.

---

### Task 1: `thoth-ocr`, the program

**Files:**
- Create: `crates/thoth-ocr/Cargo.toml` (own `[workspace]`; add `exclude = ["crates/thoth-ocr"]` to the root `Cargo.toml`), `crates/thoth-ocr/src/main.rs`, `src/protocol.rs`, `src/pdf.rs` (from the spike, hayro only), `src/textcheck.rs` (from the spike, unchanged rules), `crates/thoth-ocr/README.md`
- Modify: `.github/workflows/ci.yml` (a job: fmt, clippy, test in `crates/thoth-ocr`)
- Test: unit tests in each `src/*.rs`; `crates/thoth-ocr/tests/serve.rs` (skipped unless `THOTH_OCR_MODELS` and `ORT_DYLIB_PATH` are set)

**Interfaces:**
- Produces the program protocol, version **1**. Started as `thoth-ocr serve --models <dir> --preset openthai|pp5`, with `ORT_DYLIB_PATH` set to the library. One job per process:
  - stdin: one JSON line `{"op":"image","len":N}` or `{"op":"pdf","len":N,"maxPages":M}`, then exactly N bytes.
  - stdout, one JSON line each: `{"page":i,"pages":n,"source":"ocr"|"text","text":"…"}` per page (PDF: `source:"text"` when hayro's text layer passes `textcheck::check`, else the page is rendered at scale 2.0 and OCR'd), then `{"done":true}`; or one `{"error":"too-large"|"bad-image"|"bad-pdf"|"bad-request"|"failed","message":"…"}` and exit code 1.
  - `thoth-ocr --version` prints `thoth-ocr <crate version> protocol 1`.
- `pub fn read_request(r: &mut impl Read) -> Result<Request, ProtoError>` where `enum Request { Image(Vec<u8>), Pdf { bytes: Vec<u8>, max_pages: usize } }`; refuses `len` above 50 MB before reading.

- [ ] **Step 1: Write the failing tests** in `protocol.rs`: `reads_an_image_request`, `refuses_a_length_over_the_limit_without_reading_it` (header `len: 60_000_000`, body empty → `ProtoError::TooLarge`), `refuses_a_short_body` (len 10, 4 bytes → `BadRequest`), `refuses_an_unknown_op`. In `main.rs` (pure helpers): `nfc_and_rows` (`"เ\u{0E34}"`-style decomposed input comes out NFC), `refuses_more_than_40_megapixels` (8000×6000 header-only PNG → `too-large` without decoding the pixels; use `image::ImageReader::into_dimensions`). Move the spike's `textcheck` tests over unchanged.
- [ ] **Step 2: Run** `cargo test --manifest-path crates/thoth-ocr/Cargo.toml` — Expected: FAIL (missing functions).
- [ ] **Step 3: Implement** from the spike: `build()` for the two presets only, `serve` reading one request, images through `image::load_from_memory` (SVG and undecodable → `bad-image`), PDFs through `pdf::render`/`pdf::text_layer` with `maxPages`. `[profile.release]`: `opt-level="s"`, `lto="fat"`, `panic="abort"`, `strip=true`, `codegen-units=1` (ADR-0055: 8 MB). `ort` features `["std","load-dynamic"]`; no `download-binaries`.
- [ ] **Step 4: Run** the unit tests, then, with the spike's cached models and ONNX Runtime, `THOTH_OCR_MODELS=… ORT_DYLIB_PATH=… cargo test --manifest-path crates/thoth-ocr/Cargo.toml --release` — Expected: PASS, and `tests/serve.rs` reads `tools/ocr-spike/corpus/img/clean-sarabun-mixed.png` with oCER ≤ 2 % against its manifest text, and a `bad-image` for a 10-byte file.
- [ ] **Step 5: Commit** `feat(ocr): thoth-ocr, the OCR program (stdin/stdout, one job per run)`.

### Task 2: Build and publish the program, ONNX Runtime and the models

**Files:**
- Create: `.github/workflows/release-ocr.yml`, `scripts/publish-modules.ts`, `tests/release/publish-modules.test.ts`, `modules/models.json` (the list, unsigned source), `modules/ocr-test.png` (copy of `tools/ocr-spike/corpus/img/clean-sarabun-mixed.png`)
- Create (generated by the workflow, committed by the person who runs it): `crates/thoth-host/src/modules/runtime.json`
- Modify: `docs/deploy/release.md` (a section "OCR module"), `packages/…/THIRD-PARTY` generation if `scripts/third-party-licenses.ts` must list the new crates (it lists what ships in the app; the module's notices ship inside the download as `NOTICE.txt`)

**Interfaces:**
- `runtime.json` (compiled into the app):
  ```json
  { "version": "0.1.0", "protocol": 1, "onnxruntime": "1.28.0",
    "targets": { "aarch64-apple-darwin": [ { "name": "thoth-ocr", "url": "https://download.thothnotes.com/modules/ocr/0.1.0/aarch64-apple-darwin/thoth-ocr.gz", "size": 0, "sha256": "…", "executable": true }, { "name": "libonnxruntime.dylib", "url": "…", "size": 0, "sha256": "…" }, { "name": "NOTICE.txt", … } ] } }
  ```
  `size` and `sha256` are of the `.gz` as downloaded; every file is gzip.
- `models.json` (signed: `models.json` + `models.json.sig` at `https://download.thothnotes.com/modules/`):
  ```json
  { "serial": 1, "models": [
    { "id": "fast", "version": "openthai-2.1-20261118", "preset": "openthai", "minApp": "0.12.0", "protocol": 1, "files": [ { "name": "det.onnx", "url": "…/modules/models/fast/openthai-2.1-20261118/det.onnx.gz", "size": 0, "sha256": "…" }, … ] },
    { "id": "second", "version": "pp-ocrv5-th-20250821", "preset": "pp5", "minApp": "0.12.0", "protocol": 1, "files": [ "det.onnx", "rec.onnx", "dict.txt" as above ] } ],
    "test": { "file": { "name": "ocr-test.png", "url": "…", "size": 0, "sha256": "…" }, "expect": ["three short phrases from the image's manifest text, Thai and English"] } }
  ```
  `fast` files: `det.onnx`, `rec.onnx`, `rec2.onnx`, `rec_dict.txt`, `config.json`, `NOTICE`. A model with several versions is listed once (newest).

- [ ] **Step 1: Write the failing tests** `publish-modules.test.ts`: `fills size and sha256 of each gz`, `refuses a url outside download.thothnotes.com/modules/`, `refuses a serial not above the published one` (the script reads the live `models.json` serial; inject it), `signs with the key from the environment and never prints it`.
- [ ] **Step 2: Run** `pnpm vitest run tests/release/publish-modules.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** `release-ocr.yml` on tags `ocr-v*` and `workflow_dispatch` (input `publish`, default false):
  - matrix of the four targets (macOS jobs on `macos-latest`, Intel built with `--target x86_64-apple-darwin`);
  - ONNX Runtime 1.28.0: Microsoft's release archive for `osx-arm64`, `win-x64`, `linux-x64`, each pinned by SHA-256 in the workflow; for `x86_64-apple-darwin` use Microsoft's `osx-x86_64` archive if 1.28.0 has one, otherwise build from the `v1.28.0` tag (`./build.sh --config Release --build_shared_lib --parallel --cmake_extra_defines CMAKE_OSX_ARCHITECTURES=x86_64`, cached by version);
  - gzip each file, upload to `modules/ocr/<version>/<target>/` and the model files to `modules/models/<id>/<version>/` (same R2 secrets as `release-desktop.yml`), write `runtime.json` as a workflow artifact;
  - `publish-modules.ts` fills `models.json`, signs it with `THOTH_MODULES_SIGNING_KEY` / `THOTH_MODULES_SIGNING_KEY_PASSWORD` (Tauri's minisign signer, as `release-desktop.yml` signs updates) and uploads both with `Cache-Control: public, max-age=300`. A missing key stops the job before anything is uploaded.
- [ ] **Step 4: Run** the test file — Expected: PASS. Then run the workflow on the branch with `publish=false` (`gh workflow run release-ocr.yml --ref <branch> -f publish=false`) — Expected: all four builds green; download the Intel artifact and check `file thoth-ocr libonnxruntime.dylib` says x86_64. Do **not** tag or publish.
- [ ] **Step 5: Commit** `build(ocr): release workflow for the OCR program, ONNX Runtime and models`. Leave `runtime.json` with `"targets": {}` until the first real publish; the host treats an empty target as "not available in this build".

### Task 3: The module store (host)

**Files:**
- Create: `crates/thoth-host/src/modules/mod.rs` (`Modules`), `catalog.rs`, `store.rs`, `models.json` (the fallback: a copy of the signed list's content), `modules.pub` (the list's minisign public key)
- Modify: `crates/thoth-host/src/lib.rs` (`pub mod modules;`), `crates/thoth-host/Cargo.toml` (`minisign-verify`, `sha2`, `flate2` from the existing lock)
- Test: unit tests in `catalog.rs` and `store.rs`

**Interfaces:**
- Produces:
  ```rust
  pub enum ModelId { Fast, Second }
  pub struct Catalog { /* runtime for this target, models */ }
  impl Catalog {
      pub fn compiled() -> Catalog;
      /// Checks the signature with the compiled-in key, `serial` > `last_serial`, every URL under https://download.thothnotes.com/modules/.
      pub fn from_signed(json: &[u8], sig: &str, last_serial: u64) -> HostResult<Catalog>;
      /// The newest entry for `id` this app can run: minApp <= app version and protocol == runtime protocol.
      pub fn model(&self, id: ModelId, app: &Version) -> Option<&ModelEntry>;
  }
  pub struct Store { root: PathBuf /* <app-data>/modules/ocr */ }
  impl Store {
      pub fn installed(&self) -> Installed;            // runtime version, each model's version, bytes on disk
      pub fn install(&self, entry: Files, dest: Dest, fetch: &dyn Fetch, progress: &mut dyn FnMut(u64, Option<u64>), cancel: &AtomicBool) -> Result<PathBuf, Failure>;
      pub fn activate(&self, staged: PathBuf) -> HostResult<()>;   // rename into place, keep previous until `forget_previous`
      pub fn forget_previous(&self, dest: Dest) -> HostResult<()>;
      pub fn remove(&self, id: ModelId) -> HostResult<()>;      // runtime too when no model is left
      pub fn verify(&self, dest: Dest) -> HostResult<()>;       // SHA-256 of every file again (before each run)
  }
  ```
  Layout: `<app-data>/modules/ocr/runtime/<version>/`, `…/models/<fast|second>/<version>/`, `…/state.json` (`{ "autoUpdate": false, "serial": 0 }`). Stale `*.part` folders are deleted on start. `Failure` reuses `install::Failure` (`Offline`, `Verify`, `Disk`, `Cancelled`, `Failed`). The stored file keeps the `.gz` hash in a `files.json` next to it so `verify` checks the decompressed file against the hash recorded at install (`sha256` of the decompressed bytes, computed once after the `.gz` passed).
- `Fetch` is the existing `links/fetch.rs` fetcher used the way `updates.rs` uses it (`https_only`, a byte limit = the listed size).

- [ ] **Step 1: Write the failing tests** (§5a list, with a local test server or a fake `Fetch` as `updates.rs` tests do): `refuses_a_bad_signature`, `refuses_a_lower_or_equal_serial`, `refuses_a_file_on_another_host`, `skips_a_model_for_a_newer_app`, `a_hash_mismatch_keeps_the_installed_version_and_leaves_no_part_folder`, `a_cancelled_download_leaves_no_part_folder`, `activate_keeps_the_previous_until_forgotten`, `remove_deletes_only_that_model_and_the_runtime_with_the_last`, `stale_part_folders_are_removed_on_start`, `verify_fails_after_a_file_is_changed`, `offline_start_uses_what_is_installed`.
- [ ] **Step 2: Run** `cargo test -p thoth-host modules` — Expected: FAIL.
- [ ] **Step 3: Implement.** Hash the `.gz` while it streams; decompress only after it matches; write with the same temp-file-then-rename helper `updates.rs` uses; set the executable bit on `executable` files (Unix). Generate the list key pair with `pnpm tauri signer generate -w <file outside the repo>`; commit only the public key; tell the Main Thread where the private key file is (it is set as a secret by the owner's go, not by the builder).
- [ ] **Step 4: Run** `cargo test -p thoth-host modules` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(host): module store: signed model list, checked downloads, switch by rename`.

### Task 4: The runner and the IPC commands

**Files:**
- Create: `crates/thoth-host/src/modules/runner.rs`
- Modify: `crates/thoth-host/src/modules/mod.rs`, `crates/thoth-host/src/lib.rs` (`COMMANDS`, dispatch, a `Modules` field built like `Updates`), `crates/thoth-host/src/bin/thoth-host-stdio.rs` (events), `apps/desktop/src-tauri/src/lib.rs` (wire the data dir and events as for `update.*`), `packages/platform/src/ipc.ts` (types), the shared port contract tests (`tests/` where `update.*` commands are covered)
- Test: unit tests in `runner.rs` with a fake program (a test-only binary or script that echoes the protocol), contract test for each command

**Interfaces:**
- Consumes: `Store`, `Catalog` (Task 3); program protocol 1 (Task 1).
- Produces (ipc.ts):
  ```ts
  type ModuleModel = { id: "fast" | "second"; installed: string | null; update: string | null; downloadSize: number; size: number };
  type ModuleJob = { state: "idle" } | { state: "downloading"; model: "fast" | "second"; received: number; total: number | null } | { state: "checking"; model: "fast" | "second" } | { state: "failed"; model: "fast" | "second"; reason: "offline" | "verify" | "disk" | "cancelled" | "failed" | "test" };
  type ModuleStatus = { available: boolean; runtime: string | null; models: ModuleModel[]; autoUpdate: boolean; job: ModuleJob };
  "module.status": { args: { refresh?: boolean }; result: ModuleStatus };   // refresh: read the signed list now
  "module.install": { args: { model: "fast" | "second" }; result: ModuleStatus };  // runtime too if missing or older than runtime.json
  "module.cancel": { args: Record<string, never>; result: ModuleStatus };
  "module.remove": { args: { model: "fast" | "second" }; result: ModuleStatus };
  "module.settings": { args: { autoUpdate: boolean }; result: ModuleStatus };
  /** Request bytes: the image or the PDF. */
  "ocr.read": { args: { kind: "image" | "pdf"; model?: "fast" | "second" }; result: { model: "fast" | "second"; pages: { text: string; source: "ocr" | "text" }[] } };
  "ocr.cancel": { args: Record<string, never>; result: null };
  ```
  Events: `module.progress` (payload `ModuleStatus`), `ocr.progress` (`{ page: number; pages: number }`). `available: false` when `runtime.json` has no entry for this target. Errors (`HostError` codes): `OCR_NOT_INSTALLED`, `OCR_BUSY`, `OCR_TOO_LARGE`, `OCR_BAD_FILE`, `OCR_TIMEOUT`, `OCR_CANCELLED`, `OCR_FAILED`. `model` omitted = `fast` if installed, else `second`.
- The signed list is read together with the update check (same schedule, same privacy) and on `module.status { refresh: true }`; with `autoUpdate` on, a newer runnable model of an installed choice is installed without asking. A new model is activated only after the list's test image reads with every `expect` phrase present; otherwise `reason: "test"` and the old one stays.

- [ ] **Step 1: Write the failing tests:** runner — `kills_the_child_after_60s_without_a_page` (fake program sleeps; use an injectable timeout), `cancel_kills_the_child`, `maps_program_errors_to_codes` (`too-large`→`OCR_TOO_LARGE`, `bad-image`/`bad-pdf`→`OCR_BAD_FILE`), `a_second_job_while_one_runs_is_busy`, `verifies_hashes_before_each_run` (changed file → `OCR_FAILED`, the program is not started), `remove_while_a_job_runs_kills_it_first`, `quitting_kills_a_running_job`. Contract: each command's argument checking and `available:false` in the stdio harness.
- [ ] **Step 2: Run** `cargo test -p thoth-host modules` and the contract test — Expected: FAIL.
- [ ] **Step 3: Implement.** Spawn exactly as `agent/mod.rs` does (process group on Unix, Job Object on Windows, `kill_group`), stdin written from a thread, stdout read line by line, stderr discarded (logged at debug with no document text). Bytes over 20 MB (image) or 50 MB (PDF) are refused before spawning. Downloads run on a thread like `InApp::start`, one at a time.
- [ ] **Step 4: Run** the same tests — Expected: PASS. `pnpm check` and `cargo clippy --workspace --all-targets -- -D warnings` pass.
- [ ] **Step 5: Commit** `feat(host): run thoth-ocr as a supervised child; module and ocr commands`.

### Task 5: Settings → Modules

**Files:**
- Create: `apps/desktop/src/features/modules/ModulesSettings.tsx`, `apps/desktop/src/features/modules/service.ts` (subscribe/getState over `module.*` and `module.progress`, like `features/updates/service.ts`)
- Modify: `apps/desktop/src/features/settings/SettingsView.tsx` (section `{ id: "set-modules", label: d.modules.title, icon: "module" }` after Agents), `packages/app-ui/src/ui/Icon.tsx` (`"module"`: a box, house style), `packages/app-ui/src/strings/en.ts`, `th.ts`
- Test: `apps/desktop/test/modules-settings.test.tsx`

**Interfaces:**
- Consumes: `module.*` (Task 4).
- Produces: `createModuleService(host): ModuleService` with `subscribe`, `getState(): ModuleStatus`, `install(id)`, `cancel()`, `remove(id)`, `setAutoUpdate(on)`, `refresh()`; deep link `openSettings({ section: "modules" })` (add `"modules"` to the `section` union and `initial` mapping).

The section: heading "OCR (Thai and English)", one sentence on what it does and that images never leave the computer; two rows, **Fast** (recommended) and **Second opinion**, each with its download size or space used, and Download / Remove / Cancel, a progress bar while downloading, a plain-words line for each `reason`; "A better model is ready (6 MB)" with Update when `update` is set; a switch "Update OCR models automatically" (off by default). `available:false`: one line "OCR isn't available in this build." and no buttons.

- [ ] **Step 1: Write the failing tests:** `shows both choices with their sizes`, `download shows progress and cancel stops it`, `each failure reason has its own words` (all six), `offers the update and installs it`, `the auto-update switch calls module.settings`, `not available in this build shows no buttons`, `the deep link opens the Modules section`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/test/modules-settings.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** with existing `Button`, `Notice`, the settings row styles and a `<progress>` like `InstallPanel`.
- [ ] **Step 4: Run** the test and `pnpm check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(settings): Modules, download OCR`.

### Task 6: Copy text / Insert text below on an image

**Files:**
- Modify: `packages/app-ui/src/editor/context.ts` (`ocr?(image: { bytes: Uint8Array; mimeType: string }, model?: "fast" | "second"): Promise<OcrResult>` and `openModules?(): void`), `packages/app-ui/src/editor/block-menu.ts` (`BlockAction` gains `{ type: "copyText" } | { type: "insertText" }`, shown when `isImage` and the context has `ocr`), `packages/app-ui/src/editor/block-handle.ts` (run them), the desktop place that calls `createEditorContext` (pass `ocr` through `ocr.read`, `openModules` through `openSettings({ section: "modules" })`), strings
- Test: `packages/app-ui/test/image-ocr.test.ts` (editor with a fake `ocr`)

**Interfaces:**
- Consumes: `ocr.read`, `ocr.cancel`, `ocr.progress` (Task 4); `ctx.media().load(src)` for the bytes (already the image's checked load).
- Produces: `type OcrResult = { state: "done"; model: "fast" | "second"; text: string } | { state: "not-installed" } | { state: "cancelled" } | { state: "failed"; reason: "too-large" | "bad-file" | "timeout" | "failed" }`.

Behaviour: the block menu of an image shows **Copy text** and **Insert text below** (also reachable by keyboard: the block menu shortcut on a selected image). While it runs, a status line under the image says "Reading text…" with **Cancel**, announced politely (`aria-live`). Done: Copy puts the text on the clipboard (`ui/clipboard.ts` `copyText`) and says "Text copied"; Insert adds one paragraph per line right after the image, as one undo step. Empty text: "No text found in this image". When both choices are installed, the status line offers **Try the other model**, which runs again with the other model and replaces what Insert added (Copy just copies again). `not-installed`: "OCR isn't downloaded yet" with **Open Settings**, no download. A remote (`http`) image or one that is not loaded: the two items are disabled with the reason as their description.

- [ ] **Step 1: Write the failing tests:** `the image menu has Copy text and Insert text below only where ocr exists`, `copy puts the text on the clipboard`, `insert adds one paragraph per line after the image as one undo step`, `try the other model replaces the inserted text`, `not installed offers Settings and never calls install`, `cancel stops and says nothing was changed`, `a web image disables the items`.
- [ ] **Step 2: Run** `pnpm vitest run packages/app-ui/test/image-ocr.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and `pnpm check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(editor): copy or insert the text of an image`.

### Task 7: PDF to a page

**Files:**
- Modify: the import entry the sidebar's "New…" menu and the command palette already use (add **Page from PDF…**), using `source.pick` (file) + `source.file.open`/`source.file.read` for the bytes, then `ocr.read { kind: "pdf" }`; strings
- Test: `apps/desktop/test/pdf-to-page.test.tsx`

Behaviour: pick a PDF (≤ 50 MB, ≤ 50 pages; more pages: only the first 50, and the page says so at the top); progress "Page 3 of 12" with Cancel; the new page is created in the selected folder (as New page does), named after the file, one `## Page N` heading per page followed by its text, and a first line "Imported from `<file name>`". Pages read from the PDF's own text and pages read by OCR are both just text. Not installed: the same "OCR isn't downloaded yet" message with Open Settings (a PDF whose every page has good text still needs the program).

- [ ] **Step 1: Write the failing tests:** `makes a page with one heading per PDF page`, `stops at 50 pages and says so`, `cancel creates no page`, `not installed offers Settings`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and `pnpm check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): a page from a PDF, its own text or OCR`.

### Task 8: Licences, privacy, changelog, ADR

**Files:**
- Modify: `CHANGELOG.md`, `CHANGELOG.th.md` (Added, 3 lines each: Modules + OCR download; Copy/Insert text of an image; Page from PDF), `docs/legal/privacy.md` and `.th.md` (what the module download and the list request reveal: the same as an update download; images and PDFs never leave the computer; `<!-- REVIEW: owner -->`), the app's licences page source (`scripts/third-party-licenses.ts` or its input) to name OpenThai 2.1 (Apache-2.0, iApp, NOTICE), PaddleOCR PP-OCRv5 (Apache-2.0), ONNX Runtime (MIT), oar-ocr (Apache-2.0), hayro (Apache-2.0 OR MIT), `docs/adr/0055-ocr-module.md` (Consequences: per-job process, `runtime.json` + signed list; the Intel engine actually shipped), `docs/adr/README.md` (0055 Accepted), `docs/architecture/ocr-plan.md` status line
- Test: the existing changelog parity test

- [ ] **Step 1: Write** the entries; run `pnpm vitest run` on the changelog test — Expected: PASS.
- [ ] **Step 2: Run** `pnpm check` — Expected: exit 0.
- [ ] **Step 3: Commit** `docs: OCR in the changelog, privacy notice and licences`.

### Task 9 (may slip past 0.12.0): Weekly model watch

**Files:** Create `.github/workflows/model-watch.yml`, `scripts/model-watch.ts`.

Weekly (and by hand): for each listed model, ask Hugging Face for the repo's latest commit; if newer than the listed one, download it, run `thoth-ocr` (built in the job) on `tools/ocr-spike/corpus` with `tools/ocr-spike/scripts/score.py`, and open a PR that adds the new version to `modules/models.json` (serial + 1) only if its oCER is no worse on every image group, with the table in the PR body. Never publishes; `release-ocr.yml` signs and uploads after a person merges.

- [ ] **Step 1:** test `scripts/model-watch.ts`'s decision function: `proposes only when no group is worse`, `ignores an unchanged commit`.
- [ ] **Step 2:** implement; run once by hand on the branch (`workflow_dispatch`) — Expected: "no newer model" today.
- [ ] **Step 3: Commit** `ci: weekly OCR model watch`.

---

## After the build (Main Thread, with the owner's go)

1. Generate the list key, set `THOTH_MODULES_SIGNING_KEY` (+ password) as repository secrets, give the owner the backup file.
2. Tag `ocr-v0.1.0` → `release-ocr.yml` publishes; commit its `runtime.json` (PR).
3. The owner tests the whole of 0.12.0 from a build of `main`.
