/** Browser-safe entry: provider and `SourceHost`-based importers. Node path openers live in `./node`. */
export * from "./provider.ts";
export * from "./host-importers.ts";
export { obsidianProvider as default } from "./provider.ts";
