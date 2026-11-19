//! Phase 0 spike of `thoth-ocr` (docs/architecture/ocr-plan.md §6). Not product code.
//!
//! thoth-ocr ocr  <model-dir> <preset> <out.jsonl> <file>...   OCR images or PDFs, one JSON line per image/page
//! thoth-ocr pdftext <file.pdf>...                             PDF text layer per page + broken-text verdict
//!
//! preset: `openthai` (OpenThai 2.1 Text, oar-ocr's preset), `openthai-norec2`, or `pp5` (PP-OCRv5 mobile
//! det + th_PP-OCRv5_mobile_rec, oar-ocr defaults). PDF renderer: env THOTH_PDF=hayro|pdfium (default hayro).
//! Engine: chosen at build time (`--features native` or `--no-default-features --features tract`).

mod pdf;
mod textcheck;

use oar_ocr::oarocr::{OAROCR, OAROCRBuilder};
use std::error::Error;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let res = match args.first().map(String::as_str) {
        Some("ocr") if args.len() >= 5 => run_ocr(&args[1], &args[2], &args[3], &args[4..]),
        Some("pdftext") if args.len() >= 2 => run_pdftext(&args[1..]),
        Some("probe") if args.len() >= 2 => run_probe(&args[1..]),
        Some("render") if args.len() >= 3 => run_render(&args[1], &args[2..]),
        _ => Err("usage: thoth-ocr ocr <model-dir> <preset> <out.jsonl> <file>... | pdftext <file.pdf>...".into()),
    };
    if let Err(e) = res {
        eprintln!("error: {e}");
        let mut src = e.source();
        while let Some(s) = src {
            eprintln!("  caused by: {s}");
            src = s.source();
        }
        std::process::exit(1);
    }
}

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn engine() -> &'static str {
    #[cfg(feature = "tract")]
    {
        ort::set_api(ort_tract::api());
        "tract"
    }
    #[cfg(not(feature = "tract"))]
    {
        "onnxruntime"
    }
}

fn build(dir: &Path, preset: &str) -> Res<OAROCR> {
    let b = match preset {
        "openthai" => OAROCRBuilder::openthai_from_dir(dir),
        "openthai-norec2" => OAROCRBuilder::openthai_from_dir(dir).without_secondary_recognizer(),
        // PP-OCRv5 has no preset in oar-ocr; its dictionary is the yml's character_dict, written to dict.txt.
        "pp5" => OAROCRBuilder::new(dir.join("det.onnx"), dir.join("rec.onnx"), dir.join("dict.txt")),
        // Same models, detector fed a 1280x1280 square like OpenThai's preset (needed by the tract engine).
        "pp5-square" => OAROCRBuilder::new(dir.join("det.onnx"), dir.join("rec.onnx"), dir.join("dict.txt"))
            .detection_preprocessing(oar_ocr::oarocr::DetectionPreprocessing::PaddedLongSide),
        _ => return Err(format!("unknown preset {preset}").into()),
    };
    Ok(b.build()?)
}

fn run_ocr(model_dir: &str, preset: &str, out: &str, files: &[String]) -> Res<()> {
    let engine = engine();
    let t0 = Instant::now();
    let ocr = build(Path::new(model_dir), preset)?;
    let load_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let mut w = std::io::BufWriter::new(std::fs::File::create(out)?);
    let renderer = std::env::var("THOTH_PDF").unwrap_or_else(|_| "hayro".into());
    // Cold start: model load plus the first inference, measured on a small blank page so no corpus image is
    // timed twice; every timed image below is warm.
    let t1 = Instant::now();
    ocr.predict(vec![image::RgbImage::from_pixel(1280, 1280, image::Rgb([255; 3]))])?;
    let cold_ms = load_ms + t1.elapsed().as_secs_f64() * 1000.0;
    let mut first = true;
    for f in files {
        let path = PathBuf::from(f);
        let pages: Vec<(String, image::RgbImage, f64)> = if path.extension().is_some_and(|e| e == "pdf") {
            let bytes = std::fs::read(&path)?;
            let t = Instant::now();
            let imgs = pdf::render(&bytes, &renderer, 2.0)?;
            let each = t.elapsed().as_secs_f64() * 1000.0 / imgs.len().max(1) as f64;
            imgs.into_iter().enumerate().map(|(i, im)| (format!("{f}#{}", i + 1), im, each)).collect()
        } else {
            vec![(f.clone(), oar_ocr::utils::load_image(&path)?, 0.0)]
        };
        let square = std::env::var("THOTH_SQUARE").is_ok_and(|v| v == "1");
        for (id, img, render_ms) in pages {
            let (wd, ht) = img.dimensions();
            let img = if square { pad_square(img) } else { img };
            let t = Instant::now();
            let mut r = ocr.predict_with_rows(vec![img])?;
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            let (page, rows) = r.pop().ok_or("no result")?;
            let text = page.text_by_rows(&rows)?;
            let line = serde_json::json!({
                "id": id, "engine": engine, "preset": preset, "w": wd, "h": ht,
                "ms": ms, "render_ms": render_ms, "renderer": renderer,
                "first": first, "load_ms": load_ms, "cold_ms": cold_ms, "text": text,
            });
            first = false;
            writeln!(w, "{line}")?;
        }
    }
    Ok(())
}

fn run_pdftext(files: &[String]) -> Res<()> {
    for f in files {
        let bytes = std::fs::read(f)?;
        let renderer = std::env::var("THOTH_PDF").unwrap_or_else(|_| "hayro".into());
        for (i, text) in pdf::text_layer(&bytes, &renderer)?.into_iter().enumerate() {
            let v = textcheck::check(&text);
            println!(
                "{}",
                serde_json::json!({"id": format!("{f}#{}", i + 1), "renderer": renderer, "chars": text.chars().count(),
                    "verdict": v.verdict(), "thai": v.thai, "marks_per_base": v.marks_per_base,
                    "orphan_gaps": v.orphan_gaps, "replacement": v.replacement, "text": text})
            );
        }
    }
    Ok(())
}

/// Load each model file into a session on the built engine and report success or the error.
fn run_probe(files: &[String]) -> Res<()> {
    let engine = engine();
    for f in files {
        let t = Instant::now();
        let r = ort::session::Session::builder().and_then(|mut b| b.commit_from_file(f));
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        match r {
            Ok(_) => println!("{engine}\t{f}\tok\t{ms:.0} ms"),
            Err(e) => println!("{engine}\t{f}\tFAIL\t{e}"),
        }
    }
    Ok(())
}

/// Pad to a white square at the top left, so a padded-long-side detector input is always 1280x1280.
/// tract can't analyse these detectors with symbolic sizes, so its detector models are pinned to that size.
/// shortcut: pages under ~290 px get a smaller detector input and fail on tract; upscale them first if that matters.
fn pad_square(img: image::RgbImage) -> image::RgbImage {
    let side = img.width().max(img.height());
    let mut out = image::RgbImage::from_pixel(side, side, image::Rgb([255; 3]));
    image::imageops::replace(&mut out, &img, 0, 0);
    out
}

/// Render each PDF page to `<out-dir>/<file stem>-<page>.png` with THOTH_PDF's renderer, timing each file.
fn run_render(out_dir: &str, files: &[String]) -> Res<()> {
    let renderer = std::env::var("THOTH_PDF").unwrap_or_else(|_| "hayro".into());
    for f in files {
        let bytes = std::fs::read(f)?;
        let t = Instant::now();
        let pages = pdf::render(&bytes, &renderer, 2.0)?;
        let ms = t.elapsed().as_secs_f64() * 1000.0 / pages.len().max(1) as f64;
        let stem = Path::new(f).file_stem().ok_or("name")?.to_string_lossy();
        for (i, p) in pages.iter().enumerate() {
            let out = Path::new(out_dir).join(format!("{stem}-{}.png", i + 1));
            p.save(&out)?;
            println!("{}", serde_json::json!({"file": f, "page": i + 1, "renderer": renderer, "ms_per_page": ms, "png": out}));
        }
    }
    Ok(())
}
