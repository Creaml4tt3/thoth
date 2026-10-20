# Project Atlas

Created: October 20, 2026 9:15 AM
Status: In Progress
Tags: import, notion
Owner: Somchai
Due: November 1, 2026

<aside>
<img src="https://www.notion.so/icons/token_blue.svg" width="40px" />
This callout is exported as HTML because Markdown has no equivalent.
</aside>

<details>
<summary>Toggle: implementation notes</summary>

Hidden content inside a toggle, with **bold** text.

</details>

## Checklist

- [ ] Parse the ZIP safely
- [x] Strip the ID suffix from names
- [ ] Resolve relative links

## Code

```typescript
export function stripNotionId(name: string): string {
  return name.replace(/ [0-9a-f]{32}(\.|$)/, "$1");
}
```

## Table

| Format | Source | Lossy |
|--------|--------|-------|
| Markdown | Notion | yes |
| CSV | Notion databases | partly |

## Attachments

![diagram.png](Project%20Atlas/diagram.png)

[notes.pdf](Project%20Atlas/notes.pdf)

[Thai name.txt](Project%20Atlas/%E0%B9%84%E0%B8%9F%E0%B8%A5%E0%B9%8C%E0%B9%81%E0%B8%99%E0%B8%9A.txt)

Link to the database row: [Write importer](Tasks%208b9c0d1e2f3a4e15c6d7e8f901122334/Write%20importer%209c0d1e2f3a4b4f26d7e8f90112233445.md)
