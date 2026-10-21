import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ALPHA = `---
thoth_id: 01HZZZZZZZZZZZZZZZZZZZZZZZ
---
# Alpha

First paragraph stays exactly.

* odd bullet one
* odd bullet two

Second paragraph with __emphasis__ kept.

See [[Beta]] for more.

> [!tip] Remember
> Callouts round-trip.

\`\`\`js
const  spaced   =  1;
\`\`\`
`;

export const BETA = "# Beta\n\nBeta links back to [[Alpha]].\n";

export async function seed(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [path, data] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), data);
  }
}
