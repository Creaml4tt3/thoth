---
aliases:
  - Home Page
  - Index
tags:
  - hub
  - project/thoth
cssclasses:
  - wide-page
publish: true
custom:
  owner: Somchai
  review:
    status: draft
    due: 2026-11-01
---
# Home

Inline tag: #daily-note and a nested #area/research tag. Not a tag: C# and issue #123.

## Links

- Folder path with display text: [[Projects/Alpha|Alpha project]]
- Heading link: [[Meeting Notes#Decisions]]
- Block link: [[Beta#^summary]]
- Alias-only target: [[Start]]
- Unicode target: [[Café]] and [[การประชุม 🚀]]
- Missing target: [[Does Not Exist]]
- Markdown link with URL-encoded path: [spec](Projects/Spec%20Doc.md)
- Inside code, not a link: `[[Not A Link]]`

## Embeds

![[diagram.png]]

![[diagram.png|100]]

![[Café]]

## Callouts

> [!tip]- Folded
> Hidden until expanded.

> [!warning] Open callout
> Always visible.

## Tasks

- [ ] Write the importer
- [x] Read the spec
- [/] Half done (custom status)

## Dataview (unsupported plugin syntax)

```dataview
TABLE file.mtime AS "Modified"
FROM #project
SORT file.mtime DESC
```
