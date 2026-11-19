//! PDF pages to images (hayro or pdfium) and the PDF's own text layer (hayro).

use hayro::hayro_interpret::font::GlyphRun;
use hayro::hayro_interpret::hayro_cmap::BfString;
use hayro::hayro_interpret::{
    BlendMode, ClipPath, Context, Device, DrawMode, DrawProps, Image, ImageDrawProps, InterpreterCache,
    InterpreterSettings, SoftMask, interpret_page,
};
use hayro::hayro_syntax::Pdf;
use hayro::kurbo::{Affine, BezPath, Rect};
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{PixmapSettings, RenderCache, RenderSettings};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

pub fn render(bytes: &[u8], renderer: &str, scale: f32) -> Res<Vec<image::RgbImage>> {
    match renderer {
        "hayro" => render_hayro(bytes, scale),
        #[cfg(feature = "pdfium")]
        "pdfium" => render_pdfium(bytes, scale),
        _ => Err(format!("renderer {renderer} not built in").into()),
    }
}

fn render_hayro(bytes: &[u8], scale: f32) -> Res<Vec<image::RgbImage>> {
    let pdf = Pdf::new(bytes.to_vec()).map_err(|e| format!("hayro: {e:?}"))?;
    let cache = RenderCache::new();
    let settings = InterpreterSettings::default();
    let px = PixmapSettings { x_scale: scale, y_scale: scale, bg_color: WHITE };
    let mut out = Vec::new();
    for page in pdf.pages().iter() {
        let pix = hayro::render(page, &cache, &settings, &RenderSettings::default(), &px);
        let (w, h) = (pix.width() as u32, pix.height() as u32);
        // Opaque white background, so premultiplied RGBA is plain RGBA.
        let rgba = image::RgbaImage::from_raw(w, h, pix.data_as_u8_slice().to_vec()).ok_or("pixmap size")?;
        out.push(image::DynamicImage::ImageRgba8(rgba).to_rgb8());
    }
    Ok(out)
}

/// pdfium binds once per process.
#[cfg(feature = "pdfium")]
fn pdfium() -> Res<&'static pdfium_render::prelude::Pdfium> {
    use pdfium_render::prelude::*;
    static P: std::sync::OnceLock<Pdfium> = std::sync::OnceLock::new();
    if P.get().is_none() {
        let lib = std::env::var("PDFIUM_LIB").map_err(|_| "set PDFIUM_LIB to the pdfium library")?;
        let _ = P.set(Pdfium::new(Pdfium::bind_to_library(lib)?));
    }
    Ok(P.get().unwrap())
}

#[cfg(feature = "pdfium")]
fn render_pdfium(bytes: &[u8], scale: f32) -> Res<Vec<image::RgbImage>> {
    use pdfium_render::prelude::*;
    let doc = pdfium()?.load_pdf_from_byte_slice(bytes, None)?;
    let cfg = PdfRenderConfig::new().scale_page_by_factor(scale);
    let mut out = Vec::new();
    for page in doc.pages().iter() {
        out.push(page.render_with_config(&cfg)?.as_image()?.to_rgb8());
    }
    Ok(out)
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
                None => self.text.push('\u{FFFD}'),
            }
            self.last = Some((x, y));
        }
    }
}

pub fn text_layer(bytes: &[u8], renderer: &str) -> Res<Vec<String>> {
    #[cfg(feature = "pdfium")]
    if renderer == "pdfium" {
        use pdfium_render::prelude::*;
        let doc = pdfium()?.load_pdf_from_byte_slice(bytes, None)?;
        return doc.pages().iter().map(|p| Ok(p.text()?.all())).collect();
    }
    let _ = renderer;
    let pdf = Pdf::new(bytes.to_vec()).map_err(|e| format!("hayro: {e:?}"))?;
    let cache = InterpreterCache::new();
    let mut out = Vec::new();
    for page in pdf.pages().iter() {
        let mut sink = TextSink { text: String::new(), last: None };
        let (w, h) = page.render_dimensions();
        let mut ctx = Context::new(
            Affine::IDENTITY,
            Rect::new(0.0, 0.0, w as f64, h as f64),
            &cache,
            page.xref(),
            InterpreterSettings::default(),
        );
        interpret_page(page, &mut ctx, &mut sink);
        out.push(sink.text.trim().to_string());
    }
    Ok(out)
}
