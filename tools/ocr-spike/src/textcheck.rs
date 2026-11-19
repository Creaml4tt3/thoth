//! Is a PDF page's own Thai text usable, or did the font lose its marks (plan §6, "broken Thai PDF text")?
//!
//! Broken Thai text layers come from fonts that draw above-line vowels and tone marks as separate positioned
//! glyphs (often Private Use Area code points) without a proper ToUnicode entry. Extraction then drops the
//! mark, leaves a space where it sat, or returns PUA / U+FFFD characters.

pub struct Check {
    pub thai: usize,
    pub marks_per_base: f64,
    pub orphan_gaps: usize,
    pub replacement: usize,
}

impl Check {
    pub fn verdict(&self) -> &'static str {
        // Unreadable characters count: a page of Thai whose every glyph lost its mapping is still Thai.
        if self.thai + self.replacement < 20 {
            return "no-thai";
        }
        let per100 = self.orphan_gaps as f64 * 100.0 / self.thai as f64;
        if self.replacement > 0 || per100 >= 0.5 || (self.thai >= 200 && self.marks_per_base < 0.05) {
            "broken"
        } else {
            "ok"
        }
    }
}

fn consonant(c: char) -> bool {
    ('\u{0E01}'..='\u{0E2E}').contains(&c)
}
fn tone(c: char) -> bool {
    ('\u{0E48}'..='\u{0E4B}').contains(&c)
}
/// Vowels that can never end a syllable: a final consonant must follow (mai han-akat, sara ue, sara uee, mai taikhu).
fn needs_final(c: char) -> bool {
    matches!(c, '\u{0E31}' | '\u{0E36}' | '\u{0E37}' | '\u{0E47}')
}

pub fn check(text: &str) -> Check {
    let chars: Vec<char> = text.chars().collect();
    let thai = chars.iter().filter(|c| ('\u{0E00}'..='\u{0E7F}').contains(*c)).count();
    let bases = chars.iter().filter(|c| consonant(**c)).count();
    let tones = chars.iter().filter(|c| tone(**c)).count();
    let replacement = chars
        .iter()
        // U+FFFD, Thai PUA glyphs, or control characters (some extractors return NUL for an unmapped mark).
        .filter(|c| **c == '\u{FFFD}' || ('\u{F700}'..='\u{F71F}').contains(*c) || (c.is_control() && !c.is_whitespace()))
        .count();
    // A space right after a vowel that needs a final consonant, or a space inside "consonant ? consonant"
    // where the gap sits between a vowel-bearing syllable and its final: where a dropped mark was.
    let mut orphan_gaps = 0;
    for i in 1..chars.len().saturating_sub(1) {
        if chars[i] != ' ' || !('\u{0E01}'..='\u{0E4E}').contains(&chars[i + 1]) {
            continue;
        }
        let mut j = i - 1;
        if tone(chars[j]) && j > 0 {
            j -= 1;
        }
        // เ◌ิ (as in เริ่ม) also always takes a final consonant.
        let sara_oe = chars[j] == '\u{0E34}' && j >= 2 && chars[j - 2] == '\u{0E40}';
        if needs_final(chars[j]) || sara_oe {
            orphan_gaps += 1;
        }
    }
    Check {
        thai,
        marks_per_base: if bases == 0 { 0.0 } else { tones as f64 / bases as f64 },
        orphan_gaps,
        replacement,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const OK: &str = "ระบบนี้ช่วยให้คุณจดบันทึกได้ง่ายขึ้น ติดตั้งครั้งเดียวแล้วเริ่มต้นใช้งานได้ทันที ไม่ต้องเชื่อมต่ออินเทอร์เน็ต ข้อมูลทั้งหมดอยู่ในเครื่องของคุณเอง";
    #[test]
    fn clean_thai_is_ok() {
        assert_eq!(check(OK).verdict(), "ok");
    }
    #[test]
    fn space_where_mark_was_is_broken() {
        let broken = OK.replace("ตั้ง", "ตั ง").replace("เริ่ม", "เริ ม").replace("ขึ้น", "ขึ น");
        assert_eq!(check(&broken).verdict(), "broken");
    }
    #[test]
    fn pua_is_broken() {
        assert_eq!(check(&format!("{OK}\u{F70B}")).verdict(), "broken");
    }
    #[test]
    fn nul_is_broken() {
        assert_eq!(check(&OK.replace("ตั้ง", "ตั\u{0}ง")).verdict(), "broken");
    }
    #[test]
    fn all_unmapped_is_broken() {
        assert_eq!(check(&"\u{1}\u{2}\u{3} ".repeat(10)).verdict(), "broken");
    }
    #[test]
    fn english_is_not_judged() {
        assert_eq!(check("Install once and start right away.").verdict(), "no-thai");
    }
}
