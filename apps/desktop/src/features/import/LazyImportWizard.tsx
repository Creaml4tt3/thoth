import { lazy, Suspense, type ComponentProps } from "react";

// The import wizard and the Notion and Obsidian readers load when an import starts, not with the app.
const Wizard = lazy(() => import("./ImportWizard.tsx").then((m) => ({ default: m.ImportWizard })));

export function ImportWizard(props: ComponentProps<typeof Wizard>) {
  return (
    <Suspense fallback={null}>
      <Wizard {...props} />
    </Suspense>
  );
}
