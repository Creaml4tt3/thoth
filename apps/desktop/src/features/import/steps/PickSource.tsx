import { useState } from "react";
import type { Platform } from "@thoth/platform";
import { Button } from "../../../ui/Button.tsx";
import type { Format, System } from "../model.ts";

/** Steps 3 and 4: pick a ZIP or folder, then scan it. Scanning writes nothing. */
export function PickSource({ platform, system, scanning, error, onBack, onPicked }: {
  platform: Platform;
  system: System;
  scanning: boolean;
  error: string | null;
  onBack(): void;
  onPicked(format: Format, location: string): void;
}) {
  const [pickError, setPickError] = useState<string | null>(null);
  const pick = async (format: Format) => {
    setPickError(null);
    try {
      const location = await platform.pickImportSource(format === "zip" ? "file" : "directory");
      if (location) onPicked(format, location);
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e));
    }
  };
  const shown = error ?? pickError;
  return (
    <div className="wz-step">
      <h3 className="wz-q">{system === "notion" ? "Choose your Notion export" : "Choose your Obsidian vault"}</h3>
      <p className="muted">Thoth will scan it and show a preview. Nothing is imported or changed yet.</p>
      <div className="wz-actions wz-actions-start">
        <Button variant="primary" disabled={scanning} onClick={() => void pick("zip")}>
          Choose ZIP file
        </Button>
        <Button variant="ghost" disabled={scanning} onClick={() => void pick("folder")}>
          Choose folder
        </Button>
      </div>
      {scanning && (
        <p role="status" className="alert">
          Scanning and validating the source…
        </p>
      )}
      {shown && (
        <p role="alert" className="alert alert-danger">
          {shown}
        </p>
      )}
      <div className="wz-actions wz-actions-start">
        <Button variant="quiet" disabled={scanning} onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}
