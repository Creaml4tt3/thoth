// Template placeholders (ADR-0051 rule 10): date, time and title filled with Obsidian's defaults or a pattern; unknown
// placeholders, unsupported patterns, Templater code and anything in code blocks or inline code left exactly as written.
import { describe, expect, it } from "vitest";
import { fillPlaceholders } from "../src/index.ts";

const NOV_4 = new Date(2026, 10, 4, 9, 5); // a Wednesday

describe("fillPlaceholders", () => {
  const fill = (source: string) => fillPlaceholders(source, { now: NOV_4, title: "2026-11-04" });

  it("fills date, time and title with Obsidian's defaults, and custom patterns", () => {
    expect(fill("{{date}} {{time}} {{title}}")).toBe("2026-11-04 09:05 2026-11-04");
    expect(fill("{{date:dddd, D MMMM}} at {{time:h:mm A}}")).toBe("Wednesday, 4 November at 9:05 AM");
    expect(fill("{{ date }} {{date: YYYY }}")).toBe("2026-11-04 2026");
  });

  it("leaves unknown placeholders, unsupported patterns and Templater code exactly as written", () => {
    const text = "{{weather}} {{date:gggg}} {{title:x}} <% tp.date.now() %> {{date+1d}} {{{date}}";
    expect(fill(text)).toBe("{{weather}} {{date:gggg}} {{title:x}} <% tp.date.now() %> {{date+1d}} {2026-11-04");
  });

  it("leaves placeholders in fenced and inline code alone, and fills frontmatter", () => {
    const text = "---\ncreated: {{date}}\n---\n# {{title}}\n\n```\n{{date}}\n```\n\nUse `{{time}}` here: {{time}}.\n\n    {{date}}\n";
    expect(fill(text)).toBe("---\ncreated: 2026-11-04\n---\n# 2026-11-04\n\n```\n{{date}}\n```\n\nUse `{{time}}` here: 09:05.\n\n    {{date}}\n");
  });
});

describe("fillPlaceholders, more code", () => {
  const fill = (source: string) => fillPlaceholders(source, { now: NOV_4, title: "T" });
  it("leaves tilde fences, fences in lists and double-backtick spans alone", () => {
    const text = "~~~md\n{{title}}\n~~~\n\n- item\n\n  ```\n  {{date}}\n  ```\n\n``{{time}}`` {{title}}\n";
    expect(fill(text)).toBe("~~~md\n{{title}}\n~~~\n\n- item\n\n  ```\n  {{date}}\n  ```\n\n``{{time}}`` T\n");
  });
  it("changes nothing without placeholders", () => {
    const text = "# Plain\n\n{ { date } } and {date}\n";
    expect(fill(text)).toBe(text);
  });
});
