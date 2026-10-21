/**
 * Wikilink recognition without a second Markdown parser.
 *
 * mdast has no wikilink node, so `[[...]]` outside code and HTML is replaced by a
 * placeholder of identical length before the (single) real parse. Offsets stay
 * valid, and the placeholder survives as plain text that is mapped back to a
 * wikilink atom afterwards.
 */
export interface Wikilink {
  start: number;
  end: number;
  embed: boolean;
  target: string;
  fragment: string | null;
  label: string | null;
}

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const BASE = 64;
const DIGITS = 3;

export function parseWikiInner(inner: string): Pick<Wikilink, "target" | "fragment" | "label"> {
  const pipe = inner.indexOf("|");
  let targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
  const label = pipe === -1 ? null : inner.slice(pipe + 1);
  if (targetPart.endsWith("\\")) targetPart = targetPart.slice(0, -1); // `\|` inside tables
  const hash = targetPart.indexOf("#");
  return hash === -1
    ? { target: targetPart.trim(), fragment: null, label }
    : { target: targetPart.slice(0, hash).trim(), fragment: targetPart.slice(hash + 1).trim(), label };
}

export interface Span {
  start: number;
  end: number;
}

/** Wikilinks that are not escaped (`\[[x]]`) and do not overlap an excluded span (code, HTML). */
export function findWikilinks(body: string, excluded: Span[]): Wikilink[] {
  const found: Wikilink[] = [];
  for (const m of body.matchAll(WIKILINK)) {
    const start = m.index;
    const end = start + m[0].length;
    let slashes = 0;
    while (body[start - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 === 1 || excluded.some((s) => start < s.end && end > s.start)) continue;
    found.push({ start, end, embed: m[1] === "!", ...parseWikiInner(m[2]!) });
  }
  return found;
}

export interface Mask {
  text: string;
  /** Character that starts a placeholder; absent from the original body. */
  marker: string;
  links: Wikilink[];
}

function unusedChar(body: string, from: number): string | undefined {
  for (let c = from; c <= 0xf8ff; c++) {
    const ch = String.fromCharCode(c);
    if (!body.includes(ch)) return ch;
  }
  return undefined;
}

/** Placeholder: marker, three base-64 index digits, then filler up to the original length. */
export function maskWikilinks(body: string, links: Wikilink[]): Mask | undefined {
  const marker = unusedChar(body, 0xf000);
  if (marker === undefined || links.length === 0 || links.length >= BASE ** DIGITS) return undefined;
  const filler = unusedChar(body, marker.charCodeAt(0) + 1) ?? marker;
  let text = "";
  let cursor = 0;
  links.forEach((link, i) => {
    let index = "";
    for (let d = DIGITS - 1, n = i; d >= 0; d--, n = Math.floor(n / BASE)) index = String.fromCharCode(0xe000 + (n % BASE)) + index;
    const length = link.end - link.start;
    text += body.slice(cursor, link.start) + marker + index + filler.repeat(length - 1 - DIGITS);
    cursor = link.end;
  });
  return { text: text + body.slice(cursor), marker, links };
}

/** Splits a text value into plain strings and wikilinks. */
export function unmask(value: string, mask: Mask | undefined): (string | Wikilink)[] {
  if (!mask || !value.includes(mask.marker)) return [value];
  const out: (string | Wikilink)[] = [];
  let plain = "";
  for (let i = 0; i < value.length; ) {
    if (value[i] !== mask.marker) {
      plain += value[i++];
      continue;
    }
    let index = 0;
    for (let d = 0; d < DIGITS; d++) index = index * BASE + (value.charCodeAt(i + 1 + d) - 0xe000);
    const link = mask.links[index];
    const length = link ? link.end - link.start : 0;
    if (!link || index < 0 || i + length > value.length) {
      plain += value[i++];
      continue;
    }
    if (plain) out.push(plain);
    plain = "";
    out.push(link);
    i += length;
  }
  if (plain) out.push(plain);
  return out;
}
