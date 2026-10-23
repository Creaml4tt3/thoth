import { Button } from "@thoth/app-ui/ui/Button.tsx";
import type { System } from "../model.ts";

const HOW: Record<System, { title: string; steps: string[]; note: string }> = {
  notion: {
    title: "Export from Notion",
    steps: [
      "In Notion, open Settings, then Export all workspace content (or use the ... menu on one page and choose Export).",
      "Choose the format Markdown & CSV. Include subpages, and include databases as CSV.",
      "Notion emails or downloads a ZIP. Keep the ZIP as it is. You can also extract it and pick the folder.",
    ],
    note: "Notion does not recreate your workspace from an export, so expect a best-effort migration. The preview shows what will and will not carry over.",
  },
  obsidian: {
    title: "Prepare an Obsidian vault",
    steps: [
      "Close Obsidian, or at least let it finish syncing, so files are not changing while Thoth reads them.",
      "Pick the vault folder itself (the one that contains your notes and the .obsidian folder), or a ZIP of it.",
      "You do not need to copy anything. Thoth reads the vault and never changes it.",
    ],
    note: "Obsidian settings and plugin code are not imported. Plugin syntax such as Dataview is kept as plain text.",
  },
};

/** Step 2: how to prepare or export the source. */
export function Instructions({ system, onBack, onNext }: { system: System; onBack(): void; onNext(): void }) {
  const how = HOW[system];
  return (
    <div className="wz-step">
      <h3 className="wz-q">{how.title}</h3>
      <ol className="wz-list">
        {how.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="muted">{how.note}</p>
      <div className="wz-actions">
        <Button variant="quiet" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" onClick={onNext}>
          I have it ready
        </Button>
      </div>
    </div>
  );
}
