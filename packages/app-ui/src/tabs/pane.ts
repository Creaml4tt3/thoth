/**
 * Which pane a view is in (ADR-0030). An open page listens for window-wide keys (Cmd/Ctrl+Shift+E) and serves the
 * palette's editor commands only while its pane is the active one. Outside a pane (one pane, tests): active.
 */
import { createContext, useContext } from "react";

export interface PaneInfo {
  active: boolean;
}

export const PaneContext = createContext<PaneInfo>({ active: true });

export const usePaneActive = (): boolean => useContext(PaneContext).active;
