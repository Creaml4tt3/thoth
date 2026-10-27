import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Makes `vault` a Private Space that had its Welcome pages (ADR-0032) and deleted them, so "Start writing" opens it
 * empty, as the scenarios written before the Welcome pages expect. `first-run.e2e.ts` covers the Welcome pages.
 */
export async function welcomeDone(vault: string): Promise<void> {
  await mkdir(join(vault, ".thoth", "onboarding"), { recursive: true });
  await writeFile(join(vault, ".thoth", "onboarding", "welcome.json"), '{ "version": 1 }\n');
}
