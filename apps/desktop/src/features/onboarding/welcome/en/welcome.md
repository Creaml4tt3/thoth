# Welcome to Thoth

Thoth keeps your notes as plain Markdown files in a folder you chose, on this computer.
There is no account and no cloud: other apps can open the same files, and so can you.
This page shows every kind of block Thoth has, with how to make each one. Change it, or delete it when you are done.

Type `/` on an empty line for the block menu, or drag the handle at the left of a block to move it. Cmd/Ctrl+Shift+E switches between Blocks and Plain mode (the Markdown itself).

## Headings

# Heading 1

`/h1`, or type `#` and a space at the start of a line.

## Heading 2

`/h2`, or `##` and a space.

### Heading 3

`/h3`, or `###` and a space.

## Lists

- A bulleted list: `/bullet`, or `-` and a space.
- Enter starts the next item; Enter on an empty item ends the list.

1. A numbered list: `/numbered`, or `1.` and a space.
2. The numbers follow on by themselves.

- [ ] A to-do list: `/todo`, or `[]` and a space.
- [x] Click the box to tick an item off.

## Toggle

> [!toggle]- A toggle: click the arrow to open it
> What is inside stays hidden until you open it. Make one with `/toggle`, or `>>` and a space.

## Callouts

> [!note] Note
> A callout makes a line stand out: `/callout`. In Markdown it is a quote that starts with `[!note]`.

> [!tip] Tip
> Change the word in the brackets to change the kind: `[!tip]`.

> [!warning] Warning
> `[!warning]` is for things to be careful with.

> [!danger] Danger
> `[!danger]` is for things that cannot be undone.

> [!example] Example
> `[!example]` sets an example apart.

## Quote

> A quote: `/quote`, or `>` and a space.

## Code

```js
// A code block: /code, or three backticks and a space.
const greeting = "Hello from Thoth";
```

## Divider

A divider: `/divider`, or `---` on an empty line.

***

## Table

| Block | Markdown |
| --- | --- |
| Table | Rows of cells between pipes |
| Header | The first row, with `---` under it |

Tables are written in Plain mode: one row per line, cells between `|`.

## Image

![The Thoth ibis](thoth-welcome.svg)

`/image` picks a picture, or drop a file on the page. The file is copied next to the page, and the page links to it: `![The Thoth ibis](thoth-welcome.svg)`.

## Text styles

Select text for the style toolbar, or use the keys:

- **Bold**: Cmd/Ctrl+B, or `**bold**`.
- *Italic*: Cmd/Ctrl+I, or `*italic*`.
- <u>Underline</u>: Cmd/Ctrl+U, or `<u>underline</u>`.
- ~~Strikethrough~~: Cmd/Ctrl+Shift+S, or `~~strikethrough~~`.
- `Code`: Cmd/Ctrl+E, or a word between backticks.
- ==Highlight==: Cmd/Ctrl+Shift+H, or `==highlight==`.
- <span data-color="blue">Text colour</span>: the colour button in the toolbar.
- [A link to a web page](https://commonmark.org/help/): Cmd/Ctrl+Shift+K, or `[text](address)`.

Next: [[Linking pages]], and the [[Keyboard shortcuts]].
