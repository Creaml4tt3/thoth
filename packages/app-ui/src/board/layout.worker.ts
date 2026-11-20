import { layoutOverview } from "./layout.ts";

self.onmessage = (e: MessageEvent<{ pages: { path: string }[]; links: { from: string; to: string }[]; seed: number }>) => {
  const { pages, links, seed } = e.data;
  self.postMessage([...layoutOverview(pages, links, seed)]);
};
