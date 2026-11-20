"""Generate the synthetic Phase 0 corpus (images, PDFs and exact ground truth) into tools/ocr-spike/corpus/.

Text is original, written for this corpus. Fonts are OFL (Noto Sans/Serif Thai, Noto Sans/Serif, Sarabun), read
from the spike cache and checked against models.lock. Images are rendered by headless Chrome, so Thai is shaped
by HarfBuzz exactly as in a browser; degradations are applied with Pillow; PDFs are written with fpdf2.

Usage (from tools/ocr-spike):
  uv run --no-project --with pillow --with numpy --with fpdf2 --with uharfbuzz python -I scripts/gen_corpus.py
"""
import base64
import hashlib
import io
import json
import random
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from fpdf import FPDF
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent.parent
OUT = HERE / "corpus"
CACHE = Path.home() / "Library/Caches/thoth-ocr-spike"
FONTS = CACHE / "fonts"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

TH = [
    "การจดบันทึกที่ดีช่วยให้เราจำเรื่องสำคัญได้นานขึ้น",
    "ทุกเช้าฉันเขียนสิ่งที่ต้องทำไว้ในสมุดเล่มเล็ก",
    "ถ้าข้อมูลอยู่ในเครื่องของเราเอง เราก็ควบคุมได้ทั้งหมด",
    "ฝนตกหนักตั้งแต่เมื่อคืน ถนนหน้าบ้านจึงมีน้ำขัง",
    "คุณยายสอนให้หุงข้าวด้วยหม้อดินตามแบบโบราณ",
    "ร้านกาแฟเปิดเวลาเจ็ดโมงเช้าและปิดหกโมงเย็น",
    "นักเรียนส่งรายงานฉบับสมบูรณ์ภายในวันศุกร์นี้",
    "เจ้าหน้าที่ตรวจสอบเอกสารครบถ้วนแล้วเมื่อวานนี้",
    "ภาษาไทยมีวรรณยุกต์สี่รูป ได้แก่ เอก โท ตรี และจัตวา",
    "ผู้ใหญ่บ้านประกาศเรื่องการประชุมประจำเดือน",
    "เด็ก ๆ วิ่งเล่นกันอย่างสนุกสนานในสวนสาธารณะ",
    "โปรดเก็บใบเสร็จไว้เป็นหลักฐานในการเปลี่ยนสินค้า",
    "ศาลฎีกาพิพากษายืนตามศาลอุทธรณ์ในคดีนี้",
    "กรุณาชำระเงินภายในวันที่ ๑๕ ของทุกเดือน",
    "ปัญญาประดิษฐ์ช่วยแปลเอกสารได้รวดเร็วยิ่งขึ้น",
    "ฤดูหนาวปีนี้อากาศเย็นสบายกว่าทุกปีที่ผ่านมา",
    "ห้องสมุดประชาชนมีหนังสือใหม่มาเพิ่มอีกสามร้อยเล่ม",
    "ราคาผักและผลไม้ปรับขึ้นเล็กน้อยในช่วงหน้าแล้ง",
    "เริ่มต้นติดตั้งโปรแกรมได้ทันทีโดยไม่ต้องสมัคร",
    "พระอาทิตย์ขึ้นทางทิศตะวันออกเสมอ",
]
EN = [
    "Good notes help you remember what matters.",
    "Every morning I write my plans in a small notebook.",
    "Your files stay on your own computer, in plain text.",
    "The meeting moved from Tuesday to Thursday at 3:30 PM.",
    "Please keep the receipt (No. 48213) for any exchange.",
    "Search finds pages by title, tag, or any word inside.",
    "Backups run every night at 02:00 and keep 30 days.",
    "Send questions to the support team before Friday.",
    "The quick brown fox jumps over the lazy dog.",
    "Version 0.11.0 adds a calmer look and faster sync.",
    "Total due: $1,249.50 including 7% VAT.",
    "Open the menu, choose Settings, then Modules.",
]
MIX = [
    "ประชุมทีม Design วันพุธ เวลา 10:00 น.",
    "ดาวน์โหลด Thoth 0.11.0 ได้ที่หน้าเว็บไซต์",
    "ส่งไฟล์ PDF ขนาดไม่เกิน 20 MB ทาง email",
    "ราคาโปรโมชัน 1,290 บาท (รวม VAT 7%)",
    "เปิด Settings แล้วเลือก Modules > OCR",
    "รหัสสินค้า TH-2026-0457 จัดส่งภายใน 3 วัน",
    "ทดสอบ API ด้วย curl ก่อน deploy ขึ้น server",
    "โทร 02-123-4567 หรือ LINE @thothnotes",
    "งบประมาณ Q4 เพิ่มขึ้น 12.5% จากไตรมาสก่อน",
    "อ่านคู่มือ Getting Started ก่อนเริ่มใช้งาน",
    "บันทึก Markdown ไว้ในโฟลเดอร์ Notes/2026",
    "สมัครสมาชิกฟรี 30 วัน ไม่ต้องใช้บัตรเครดิต",
]
TEXTS = {"th": TH, "en": EN, "mixed": MIX}
FACES = {  # family name -> (Thai file, Latin file)
    "sans": ("notosansthai_NotoSansThai.ttf", "notosans_NotoSans.ttf"),
    "sarabun": ("sarabun_Sarabun-Regular.ttf", "sarabun_Sarabun-Regular.ttf"),
    "serif": ("notoserifthai_NotoSerifThai.ttf", "notoserif_NotoSerif.ttf"),
}


def check_fonts():
    lock = (HERE / "models.lock").read_text()
    for line in lock.splitlines():
        m = re.match(r"([0-9a-f]{64})\s+fonts/(\S+)", line)
        if m:
            got = hashlib.sha256((FONTS / m[2]).read_bytes()).hexdigest()
            assert got == m[1], f"font {m[2]} does not match models.lock"


def lines_of(lang, start, n):
    src = TEXTS[lang]
    return [src[(start + i) % len(src)] for i in range(n)]


def css_font(face):
    th, la = FACES[face]
    b = lambda f: base64.b64encode((FONTS / f).read_bytes()).decode()
    return (f"@font-face{{font-family:T;src:url(data:font/ttf;base64,{b(th)})}}"
            f"@font-face{{font-family:L;src:url(data:font/ttf;base64,{b(la)})}}")


def chrome(html, w, h, out):
    with tempfile.TemporaryDirectory() as d:
        page = Path(d) / "p.html"
        page.write_text(html, encoding="utf-8")
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={d}/prof",
                        "--force-device-scale-factor=1", f"--window-size={w},{h}", f"--screenshot={out}",
                        page.as_uri()], check=True, capture_output=True)


def render_lines(lines, face="sans", size=28, fg="#111", bg="#fff", width=1200, pad=40):
    lh = round(size * 1.7)
    h = pad * 2 + lh * len(lines)
    body = "".join(f"<div>{l}</div>" for l in lines)
    html = (f"<html><head><meta charset=utf-8><style>{css_font(face)}html,body{{margin:0;background:{bg}}}"
            f"body{{padding:{pad}px;font:{size}px/{lh}px L,T;color:{fg}}}"
            f"div{{white-space:nowrap}}</style></head><body>{body}</body></html>")
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "s.png"
        chrome(html, width, h, out)
        return Image.open(out).convert("RGB")


def render_columns(left, right, face="sarabun", size=24, width=1240, pad=60, gap=90):
    """Two columns of wrapped prose, like a newsletter. Chrome wraps Thai at word boundaries (ICU), which the
    scorer's Thai join rule undoes, so the ground truth is the paragraph text, left column first."""
    lh = round(size * 1.7)
    col = lambda ps: "".join(f"<p>{x}</p>" for x in ps)
    cw = (width - 2 * pad - gap) // 2
    html = (f"<html><head><meta charset=utf-8><style>{css_font(face)}html,body{{margin:0;background:#fff}}"
            f"body{{padding:{pad}px;font:{size}px/{lh}px L,T;color:#111;display:flex;gap:{gap}px;align-items:flex-start}}"
            f"section{{width:{cw}px}}p{{margin:0 0 {lh // 2}px}}</style></head>"
            f"<body><section>{col(left)}</section><section>{col(right)}</section></body></html>")
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "s.png"
        chrome(html, width, 1400, out)
        img = Image.open(out).convert("RGB")
    # Trim the empty bottom.
    a = np.asarray(img.convert("L")) < 200
    rows = np.where(a.any(axis=1))[0]
    return img.crop((0, 0, width, min(img.height, int(rows[-1]) + pad)))


def skew(img, deg):
    return img.rotate(deg, resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255))


def noise(img, sigma, seed):
    a = np.asarray(img).astype(np.float32)
    a += np.random.default_rng(seed).normal(0, sigma, a.shape)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def jpeg(img, q):
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=q)
    return Image.open(io.BytesIO(buf.getvalue())).convert("RGB")


def scan_page(lines):
    img = render_lines(lines, face="sarabun", size=26, fg="#1a1a1a", bg="#f3efe6", width=1240, pad=70)
    return noise(img.filter(ImageFilter.GaussianBlur(0.5)), 6, 7)


manifest = []


def save_img(id_, img, group, lang, lines, fmt="png", note=""):
    path = OUT / "img" / f"{id_}.{fmt}"
    if fmt == "jpg":
        img.save(path, "JPEG", quality=85)
    else:
        img.save(path, optimize=True)
    manifest.append({"id": id_, "file": f"img/{path.name}", "group": group, "lang": lang, "lines": lines,
                     "note": note})


# --- PDFs ---------------------------------------------------------------------------------------------------------

def pdf_text(path, pages, compress=True, shaping=False):
    """A PDF with a real text layer in Sarabun. Unshaped by default: fpdf2's shaped output maps the sara am
    glyphs it splits to U+FFFD, so the shaped file is itself an example of a damaged layer."""
    pdf = FPDF(format="A5")
    pdf.compress = compress
    pdf.add_font("sarabun", fname=str(FONTS / FACES["sarabun"][0]))
    pdf.set_font("sarabun", size=13)
    pdf.set_text_shaping(shaping)
    for lines in pages:
        pdf.add_page()
        for l in lines:
            pdf.cell(0, 8, l, new_x="LMARGIN", new_y="NEXT")
    pdf.output(str(path))


def chrome_pdf(path, lines):
    """Chrome's own "Save as PDF": its text layer loses the shifted tone marks (they extract as NUL or U+FFFD)."""
    html = (f"<html><head><meta charset=utf-8><style>{css_font('sarabun')}body{{font:16px L,T}}</style></head>"
            f"<body>{''.join(f'<div>{l}</div>' for l in lines)}</body></html>")
    with tempfile.TemporaryDirectory() as d:
        page = Path(d) / "p.html"
        page.write_text(html, encoding="utf-8")
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", f"--user-data-dir={d}/prof", "--no-pdf-header-footer",
                        f"--print-to-pdf={path}", page.as_uri()], check=True, capture_output=True)


def drop_tounicode_marks(path):
    """Remove the ToUnicode entries of the four tone marks: they still draw, but extract as unknown glyphs.
    This is how real broken Thai PDFs lose their marks (a font whose CMap misses the mark glyphs)."""
    data = path.read_bytes()
    marks = {f"{c:04X}" for c in range(0x0E48, 0x0E4C)}
    out, n = [], 0
    for line in data.split(b"\n"):
        m = re.match(rb"<([0-9A-Fa-f]+)> <([0-9A-Fa-f]{4})>$", line.strip())
        if m and m[2].decode().upper() in marks:
            n += 1
            continue
        out.append(line)
    assert n > 0, "no tone mark entries found in ToUnicode"
    fixed = b"\n".join(out)
    # The stream lengths change; let fpdf-style readers recompute: rewrite each /Length of the CMap stream.
    fixed = re.sub(rb"/Length (\d+)(\s*>>\s*stream\n)(.*?)(\nendstream)",
                   lambda m: b"/Length %d%s%s%s" % (len(m[3]), m[2], m[3], m[4]), fixed, flags=re.S)
    path.write_bytes(fixed)
    return n


def pdf_image_with_text(path, img, lines, page_w=148, page_h=210):
    """An image-only page with an invisible text layer (what a scanner's OCR writes)."""
    pdf = FPDF(format="A5")
    pdf.add_font("sarabun", fname=str(FONTS / FACES["sarabun"][0]))
    pdf.set_font("sarabun", size=13)
    pdf.add_page()
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "i.png"
        img.save(p)
        pdf.image(str(p), x=0, y=0, w=page_w)
    if lines:
        pdf.text_mode = "INVISIBLE"
        pdf.set_xy(10, 10)
        for l in lines:
            pdf.cell(0, 8, l, new_x="LMARGIN", new_y="NEXT")
    pdf.output(str(path))


def break_stacked_marks(s):
    """A tone mark or thanthakhat stacked on an upper vowel becomes a space: ตั้ง -> ตั ง."""
    return re.sub("([ัิ-ื็])[่-์]", "\\1 ", s)


def main():
    check_fonts()
    (OUT / "img").mkdir(parents=True, exist_ok=True)
    (OUT / "pdf").mkdir(parents=True, exist_ok=True)

    # Clean: 3 faces x 3 languages, 6 lines at 28 px.
    base = {}
    for fi, face in enumerate(FACES):
        for li, lang in enumerate(TEXTS):
            lines = lines_of(lang, fi * 6 + li, 6)
            img = render_lines(lines, face=face)
            base[(face, lang)] = (img, lines)
            save_img(f"clean-{face}-{lang}", img, "synthetic-clean", lang, lines)
    # Sizes.
    for id_, face, lang, size, start in [("small16-sans-th", "sans", "th", 16, 3), ("large44-sarabun-th", "sarabun", "th", 44, 9),
                                          ("small18-sans-mixed", "sans", "mixed", 18, 5), ("small16-serif-en", "serif", "en", 16, 2)]:
        lines = lines_of(lang, start, 6)
        save_img(f"clean-{id_}", render_lines(lines, face=face, size=size), "synthetic-clean", lang, lines)
    # A clean, flat scan-like A4 page and a two-column page.
    scan_lines = TH[:20]
    scan = scan_page(scan_lines)
    save_img("clean-scan-a4-th", scan, "synthetic-clean", "th", scan_lines, fmt="jpg", note="flat scan-like page")
    paras = lambda src, a, n, k: [" ".join(src[a + i * k + j] for j in range(k)) for i in range(n)]
    left, right = paras(TH, 0, 3, 3), paras(TH, 9, 3, 3)
    save_img("columns-two-th", render_columns(left, right), "synthetic-columns", "th", left + right,
             note="two columns of Thai prose; read left column first")
    left, right = paras(MIX, 0, 3, 2), [" ".join(EN[0:3]), " ".join(EN[3:6]), " ".join(MIX[6:8])]
    save_img("columns-two-mixed", render_columns(left, right, face="sans"), "synthetic-columns", "mixed",
             left + right, note="two columns, mixed and English prose")

    # Degraded.
    deg = [
        ("blur12-sans-th", ("sans", "th"), lambda i: i.filter(ImageFilter.GaussianBlur(1.2))),
        ("blur12-sarabun-mixed", ("sarabun", "mixed"), lambda i: i.filter(ImageFilter.GaussianBlur(1.2))),
        ("blur20-serif-th", ("serif", "th"), lambda i: i.filter(ImageFilter.GaussianBlur(2.0))),
        ("blur20-sans-en", ("sans", "en"), lambda i: i.filter(ImageFilter.GaussianBlur(2.0))),
        ("skew3-sarabun-th", ("sarabun", "th"), lambda i: skew(i, 3)),
        ("skew5-sans-mixed", ("sans", "mixed"), lambda i: skew(i, -5)),
        ("skew5-serif-en", ("serif", "en"), lambda i: skew(i, 5)),
        ("jpeg15-sans-th", ("sans", "th"), lambda i: jpeg(i, 15)),
        ("jpeg15-serif-mixed", ("serif", "mixed"), lambda i: jpeg(i, 15)),
        ("photo-sarabun-th", ("sarabun", "th"),
         lambda i: jpeg(noise(skew(i.filter(ImageFilter.GaussianBlur(1.0)), 2), 10, 3), 40)),
    ]
    for id_, key, f in deg:
        img, lines = base[key]
        save_img(f"deg-{id_}", f(img), "synthetic-degraded", key[1], lines)
    for id_, face, lang, fg, bg, start in [("lowcontrast-sans-th", "sans", "th", "#8c8c8c", "#c4c4c4", 12),
                                            ("lowcontrast-serif-en", "serif", "en", "#9a9a9a", "#cfcfcf", 6),
                                            ("dark-sans-th", "sans", "th", "#f2f2f2", "#1e1e1e", 14),
                                            ("dark-sarabun-mixed", "sarabun", "mixed", "#e8e8e8", "#23262b", 6),
                                            ("dark-color-serif-th", "serif", "th", "#ffd166", "#1d3557", 4)]:
        lines = lines_of(lang, start, 6)
        save_img(f"deg-{id_}", render_lines(lines, face=face, fg=fg, bg=bg), "synthetic-degraded", lang, lines)

    # PDFs: good text layer (Thai page + mixed page), English good, tone-mark CMap removed, invisible broken layer,
    # and image-only.
    pdfs = []
    p_good = [TH[:12], MIX[:12]]
    pdf_text(OUT / "pdf/good-text.pdf", p_good)
    pdfs += [("good-text.pdf", 1, "th", p_good[0], "ok"), ("good-text.pdf", 2, "mixed", p_good[1], "ok")]
    pdf_text(OUT / "pdf/shaped-sara-am.pdf", [TH[:12]], shaping=True)
    pdfs.append(("shaped-sara-am.pdf", 1, "th", TH[:12], "broken"))
    chrome_pdf(OUT / "pdf/chrome-print.pdf", TH[:12])
    pdfs.append(("chrome-print.pdf", 1, "th", TH[:12], "broken"))
    pdf_text(OUT / "pdf/good-text-en.pdf", [EN])
    pdfs.append(("good-text-en.pdf", 1, "en", EN, "no-thai"))
    pdf_text(OUT / "pdf/broken-cmap.pdf", [TH[8:20]], compress=False)
    n = drop_tounicode_marks(OUT / "pdf/broken-cmap.pdf")
    print(f"broken-cmap.pdf: removed {n} ToUnicode entries")
    pdfs.append(("broken-cmap.pdf", 1, "th", TH[8:20], "broken"))
    page_img = render_lines(TH[:12], face="sarabun", size=26, width=1240, pad=70)
    pdf_image_with_text(OUT / "pdf/broken-invisible.pdf", page_img, [break_stacked_marks(l) for l in TH[:12]])
    pdfs.append(("broken-invisible.pdf", 1, "th", TH[:12], "broken"))
    pdf_image_with_text(OUT / "pdf/image-only.pdf", scan_page(TH[4:16]), [])
    pdfs.append(("image-only.pdf", 1, "th", TH[4:16], "no-text"))
    for f, page, lang, lines, expect in pdfs:
        manifest.append({"id": f"{f}#{page}", "file": f"pdf/{f}", "page": page, "group": "pdf", "lang": lang,
                         "lines": lines, "text_layer": expect})

    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(manifest)} items")


if __name__ == "__main__":
    sys.exit(main())
