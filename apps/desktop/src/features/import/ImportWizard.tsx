import { useCallback, useEffect, useRef, useState } from "react";
import type { ImportManifest } from "@thoth/importer-core";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { checkDestination, sourceKindFor, type Format, type System } from "./model.ts";
import type { ScanResult } from "./service.ts";
import { ChooseSource } from "./steps/ChooseSource.tsx";
import { Destination } from "./steps/Destination.tsx";
import { Instructions } from "./steps/Instructions.tsx";
import { Options, type WizardOptions } from "./steps/Options.tsx";
import { PickSource } from "./steps/PickSource.tsx";
import { Preview } from "./steps/Preview.tsx";
import { Report } from "./steps/Report.tsx";
import { RunProgress } from "./steps/RunProgress.tsx";
import { useImportRun } from "./useImportRun.ts";

type Step = "source" | "instructions" | "pick" | "preview" | "destination" | "options" | "run" | "report";
const ORDER: Step[] = ["source", "instructions", "pick", "preview", "destination", "options", "run", "report"];

interface Props {
  onClose(): void;
  onOpenFolder(folder: string): void;
  onOpenPage(path: string): void;
}

/**
 * The Night import wizard (spec 7.1). Steps 1 to 9 are screens; step 4 (scan)
 * happens between "pick" and "preview", step 10 (source never modified) is
 * stated on the preview and the report.
 */
export function ImportWizard({ onClose, onOpenFolder }: Props) {
  const { platform, importService: service, revision } = useSession();
  const w = useDesktopStrings().wizard;
  const { view, start, resume, cancel, reset } = useImportRun(service);
  const [step, setStep] = useState<Step>("source");
  const [system, setSystem] = useState<System>("notion");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [options, setOptions] = useState<WizardOptions>({ conflictPolicy: "rename", addIdentityFrontmatter: true });
  const [preparing, setPreparing] = useState(false);
  const scanRef = useRef<ScanResult | null>(null);
  scanRef.current = scan;
  const heading = useRef<HTMLHeadingElement>(null);

  // An unrun scan holds the source open; release it when the wizard goes away.
  useEffect(
    () => () => {
      const held = scanRef.current;
      if (held && held.manifest.state === "planned") void service.discard(held);
    },
    [service],
  );
  useEffect(() => heading.current?.focus(), [step]);

  const drop = useCallback(async () => {
    const held = scanRef.current;
    setScan(null);
    if (held) await service.discard(held);
  }, [service]);

  const onPicked = async (format: Format, location: string) => {
    setError(null);
    setScanning(true);
    await drop();
    try {
      const result = await service.scan(sourceKindFor(system, format), location);
      setScan(result);
      setDestination(result.manifest.options.destinationRoot);
      setStep("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  const begin = async () => {
    const held = scanRef.current;
    const dest = checkDestination(destination);
    if (!held || !dest.ok) return;
    setError(null);
    setPreparing(true);
    try {
      // Destination and options change collision handling, so plan again over the same open source.
      const planned = await service.replan(held, { destinationRoot: dest.root, ...options });
      setScan(planned);
      setStep("run");
      void start(planned);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreparing(false);
    }
  };

  const resumeJob = async (job: ImportManifest) => {
    await drop();
    setStep("run");
    void resume(job.jobId, job.options.destinationRoot);
  };

  // Move to the report when a run settles.
  useEffect(() => {
    if (step === "run" && (view.status === "finished" || view.status === "failed")) setStep("report");
  }, [step, view.status]);

  const closeAndReset = () => {
    reset();
    onClose();
  };

  const index = ORDER.indexOf(step);
  return (
    <div className="wizard" data-theme="night" role="region" aria-label={w.region}>
      <header className="wz-head">
        <div>
          <p className="label">{w.stepOf(index + 1, ORDER.length)}</p>
          <h2 ref={heading} tabIndex={-1} className="wz-title">
            {w.titles[step]}
          </h2>
        </div>
        {step !== "run" && (
          <Button variant="quiet" small onClick={closeAndReset}>
            {w.close}
          </Button>
        )}
      </header>
      <ol className="wz-steps" aria-hidden="true">
        {ORDER.map((s, i) => (
          <li key={s} data-state={i < index ? "done" : i === index ? "current" : "todo"} />
        ))}
      </ol>
      {step === "source" && <ChooseSource service={service} revision={revision} system={system} onSystem={setSystem} onNext={() => setStep("instructions")} onResume={(job) => void resumeJob(job)} resumeDisabled={view.status === "running"} />}
      {step === "instructions" && <Instructions system={system} onBack={() => setStep("source")} onNext={() => setStep("pick")} />}
      {step === "pick" && <PickSource platform={platform} system={system} scanning={scanning} error={error} onBack={() => setStep("instructions")} onPicked={(f, l) => void onPicked(f, l)} />}
      {step === "preview" && scan && <Preview preview={scan.preview} manifest={scan.manifest} onBack={() => void drop().then(() => setStep("pick"))} onNext={() => setStep("destination")} />}
      {step === "destination" && <Destination value={destination} onChange={setDestination} onBack={() => setStep("preview")} onNext={() => setStep("options")} />}
      {step === "options" && <Options value={options} onChange={setOptions} busy={preparing} error={error} onBack={() => setStep("destination")} onStart={() => void begin()} />}
      {step === "run" && <RunProgress view={view} onCancel={cancel} />}
      {step === "report" && (
        <>
          {view.error && (
            <p role="alert" className="alert alert-danger">
              {view.error}
            </p>
          )}
          {view.report ? (
            <Report
              report={view.report}
              destinationRoot={view.destinationRoot}
              onOpenFolder={() => {
                reset();
                onOpenFolder(view.destinationRoot);
              }}
              onResume={() => view.jobId && void resume(view.jobId, view.destinationRoot).then(() => setStep("run"))}
              onDone={closeAndReset}
            />
          ) : (
            <div className="wz-actions">
              <Button variant="ghost" onClick={() => setStep("source")}>
                {w.backToStart}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
