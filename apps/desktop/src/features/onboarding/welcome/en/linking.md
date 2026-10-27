# Linking pages

Pages link to each other by name. Type `[[` and start typing a page's name to pick it from a list.

## Kinds of link

- A link to a page: [[Welcome to Thoth]]
- A link to a page in a folder: [[Getting started/Keyboard shortcuts]]
- A link with its own text (an alias): [[Welcome to Thoth|the first page]]
- A link to a heading on another page: [[Welcome to Thoth#Callouts]]
- A link to a heading on this page: [[#Backlinks]]
- A Markdown link to a page, as other apps write it: [Welcome to Thoth](Welcome%20to%20Thoth.md)
- A link to a web page: [CommonMark help](https://commonmark.org/help/)

In Markdown a link is the page name between double brackets: `[[Page]]`, `[[Page|text]]`, `[[Page#Heading]]`.

## Embed

An embed shows that a page belongs here, written with an `!` in front: `![[Page]]`.

![[Getting started/Keyboard shortcuts]]

## Backlinks

Every page lists the pages that link to it, under the page: open [[Welcome to Thoth]] and you will find this page there. When a page is renamed or moved, Thoth updates the links to it.
