//! The real program on a corpus image. Skipped unless THOTH_OCR_MODELS (a folder with `openthai/` and `pp5/`
//! model folders) and ORT_DYLIB_PATH (ONNX Runtime 1.28.0) are set.

use std::io::Write;
use std::process::{Command, Stdio};

const CORPUS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tools/ocr-spike/corpus");

fn env() -> Option<String> {
    std::env::var_os("ORT_DYLIB_PATH")?;
    std::env::var("THOTH_OCR_MODELS").ok()
}

/// Runs one job and returns stdout's JSON lines and the exit code.
fn run(models: &str, preset: &str, header: &str, body: &[u8]) -> (Vec<serde_json::Value>, i32) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_thoth-ocr"))
        .args(["serve", "--models", &format!("{models}/{preset}"), "--preset", preset])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(header.as_bytes()).unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.write_all(body).unwrap();
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    let lines = String::from_utf8(out.stdout).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    (lines, out.status.code().unwrap())
}

fn distance(a: &[char], b: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            cur.push((prev[j] + usize::from(ca != cb)).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Order-free CER (ADR-0055 "oCER"): each truth line against its closest output line.
fn ocer(truth: &[String], text: &str) -> f64 {
    let out: Vec<Vec<char>> = text.lines().map(|l| l.chars().collect()).collect();
    let (mut errors, mut total) = (0, 0);
    for t in truth {
        let t: Vec<char> = t.chars().collect();
        errors += out.iter().map(|o| distance(&t, o)).min().unwrap_or(t.len());
        total += t.len();
    }
    errors as f64 / total as f64
}

#[test]
fn reads_the_mixed_corpus_image() {
    let Some(models) = env() else { return eprintln!("skipped: set THOTH_OCR_MODELS and ORT_DYLIB_PATH") };
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(format!("{CORPUS}/manifest.json")).unwrap()).unwrap();
    let item = manifest.as_array().unwrap().iter().find(|i| i["id"] == "clean-sarabun-mixed").unwrap();
    let truth: Vec<String> = serde_json::from_value(item["lines"].clone()).unwrap();
    let png = std::fs::read(format!("{CORPUS}/img/clean-sarabun-mixed.png")).unwrap();
    for preset in ["openthai", "pp5"] {
        let (lines, code) = run(&models, preset, &format!(r#"{{"op":"image","len":{}}}"#, png.len()), &png);
        assert_eq!(code, 0, "{preset}: {lines:?}");
        assert_eq!(lines[0]["source"], "ocr");
        assert_eq!(lines.last().unwrap()["done"], true);
        let score = ocer(&truth, lines[0]["text"].as_str().unwrap());
        assert!(score <= 0.02, "{preset}: oCER {score}");
    }
}

#[test]
fn a_ten_byte_file_is_a_bad_image() {
    let Some(models) = env() else { return eprintln!("skipped: set THOTH_OCR_MODELS and ORT_DYLIB_PATH") };
    let (lines, code) = run(&models, "openthai", r#"{"op":"image","len":10}"#, b"0123456789");
    assert_eq!(code, 1);
    assert_eq!(lines, vec![serde_json::json!({"error": "bad-image", "message": lines[0]["message"]})]);
}

#[test]
fn a_pdf_uses_its_good_text_and_ocrs_the_rest() {
    let Some(models) = env() else { return eprintln!("skipped: set THOTH_OCR_MODELS and ORT_DYLIB_PATH") };
    for (file, source) in [("good-text.pdf", "text"), ("broken-cmap.pdf", "ocr"), ("image-only.pdf", "ocr")] {
        let pdf = std::fs::read(format!("{CORPUS}/pdf/{file}")).unwrap();
        let (lines, code) = run(&models, "openthai", &format!(r#"{{"op":"pdf","len":{},"maxPages":1}}"#, pdf.len()), &pdf);
        assert_eq!(code, 0, "{file}: {lines:?}");
        assert_eq!((lines[0]["page"].as_u64(), lines[0]["pages"].as_u64()), (Some(1), Some(1)), "{file}");
        assert_eq!(lines[0]["source"], source, "{file}");
        assert!(!lines[0]["text"].as_str().unwrap().is_empty(), "{file}");
        assert_eq!(lines.len(), 2, "{file}: maxPages 1 gives one page and done");
    }
}

#[test]
fn version_names_the_protocol() {
    let out = Command::new(env!("CARGO_BIN_EXE_thoth-ocr")).arg("--version").output().unwrap();
    assert_eq!(String::from_utf8(out.stdout).unwrap(), format!("thoth-ocr {} protocol 1\n", env!("CARGO_PKG_VERSION")));
}
