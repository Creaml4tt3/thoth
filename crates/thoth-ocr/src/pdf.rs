//! PDF pages to images and the PDF's own text layer, both through hayro (ADR-0055 Decision 4).

use hayro::hayro_interpret::font::GlyphRun;
use hayro::hayro_interpret::hayro_cmap::BfString;
use hayro::hayro_interpret::{
    BlendMode, ClipPath, Context, Device, DrawMode, DrawProps, Image, ImageDrawProps, InterpreterCache, InterpreterSettings, SoftMask, interpret_page,
};
use hayro::hayro_syntax::Pdf;
use hayro::kurbo::{Affine, BezPath, Rect};
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{PixmapSettings, RenderCache, RenderSettings};

pub fn open(bytes: Vec<u8>) -> Result<Pdf, String> {
    Pdf::new(bytes).map_err(|e| format!("{e:?}"))
}

/// Page `i` as an image at `scale`, smaller when that would pass `max_pixels` (a huge page can't exhaust memory).
pub fn render(pdf: &Pdf, i: usize, scale: f32, max_pixels: u64) -> Result<image::RgbImage, String> {
    let page = pdf.pages().get(i).ok_or("no such page")?;
    let (w, h) = page.render_dimensions();
    let area = (w as f64 * h as f64).max(1.0);
    let scale = scale.min((max_pixels as f64 / area).sqrt() as f32);
    let px = PixmapSettings { x_scale: scale, y_scale: scale, bg_color: WHITE };
    let pix = hayro::render(page, &RenderCache::new(), &InterpreterSettings::default(), &RenderSettings::default(), &px);
    let (w, h) = (pix.width() as u32, pix.height() as u32);
    // Opaque white background, so premultiplied RGBA is plain RGBA.
    let rgba = image::RgbaImage::from_raw(w, h, pix.data_as_u8_slice().to_vec()).ok_or("pixmap size")?;
    Ok(image::DynamicImage::ImageRgba8(rgba).to_rgb8())
}

/// Glyphs in drawing order with their position; spaces and newlines are inferred from the gaps.
struct TextSink {
    text: String,
    last: Option<(f64, f64)>,
}

impl<'a> Device<'a> for TextSink {
    fn draw_path(&mut self, _: &BezPath, _: DrawProps<'a>, _: &DrawMode) {}
    fn push_clip_path(&mut self, _: &ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
    fn draw_image(&mut self, _: Image<'a, '_>, _: ImageDrawProps<'a>) {}
    fn pop_clip(&mut self) {}
    fn pop_transparency_group(&mut self) {}
    fn draw_glyph_run(&mut self, run: &GlyphRun<'_, 'a>, props: DrawProps<'a>, _: &DrawMode) {
        for g in run.glyphs() {
            let t = props.transform * g.transform();
            let [a, _, _, d, x, y] = t.as_coeffs();
            // Glyph transforms are in 1/1000 em; this is the font size in page units.
            let size = (a.abs().max(d.abs()) * 1000.0).max(1.0);
            if let Some((lx, ly)) = self.last {
                if (y - ly).abs() > size * 0.6 {
                    self.text.push('\n');
                } else if x - lx > size * 0.75 {
                    // shortcut: a glyph start more than 0.75 em past the previous one is a word gap; no advance widths.
                    self.text.push(' ');
                }
            }
            match g.as_unicode() {
                Some(BfString::Char(c)) => self.text.push(c),
                Some(BfString::String(s)) => self.text.push_str(&s),
                // An unmapped glyph: textcheck counts U+FFFD, so the page goes to OCR.
                None => self.text.push('\u{FFFD}'),
            }
            self.last = Some((x, y));
        }
    }
}

/// Page `i`'s own text, or "" when it has none.
pub fn text_layer(pdf: &Pdf, i: usize) -> String {
    let Some(page) = pdf.pages().get(i) else { return String::new() };
    let mut sink = TextSink { text: String::new(), last: None };
    let (w, h) = page.render_dimensions();
    let cache = InterpreterCache::new();
    let mut ctx = Context::new(Affine::IDENTITY, Rect::new(0.0, 0.0, w as f64, h as f64), &cache, page.xref(), InterpreterSettings::default());
    interpret_page(page, &mut ctx, &mut sink);
    sink.text.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_broken_pdf_is_an_error() {
        assert!(open(b"%PDF-1.7 not really".to_vec()).is_err());
    }

    #[test]
    fn reads_and_renders_the_corpus_pdf() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tools/ocr-spike/corpus/pdf/good-text.pdf")).unwrap();
        let pdf = open(bytes).unwrap();
        assert_eq!(pdf.pages().len(), 2);
        assert!(text_layer(&pdf, 0).contains("ทุกเช้าฉันเขียน"));
        let img = render(&pdf, 0, 2.0, 40_000_000).unwrap();
        let small = render(&pdf, 0, 2.0, 10_000).unwrap();
        assert!(img.width() > small.width() && small.width() as u64 * small.height() as u64 <= 10_000);
    }
}
