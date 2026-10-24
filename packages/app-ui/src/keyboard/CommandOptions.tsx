import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { useStrings } from "../strings/index.ts";
import { commandText, filterCommands, isCommandQuery, type Command } from "./commands.ts";

export interface CommandMode {
  /** The text typed starts with `>`: the palette shows commands, not search results. */
  on: boolean;
  items: Command[];
  active: number;
  setActive(index: number): void;
  /** `id` of the listbox and the prefix of its options' ids. */
  listId: string;
  /** The id of the highlighted option, for `aria-activedescendant`. */
  activeId: string | undefined;
  /** Arrow keys, Home, End and Enter in the command list. Returns true when the key was used. */
  onKeyDown(event: KeyboardEvent): boolean;
  run(command: Command | undefined): void;
}

/**
 * The command half of a palette. A palette keeps its own input and search; this adds the `>` mode: what was typed
 * after it filters the commands, the arrow keys move through them and Enter runs the highlighted one.
 */
export function useCommandMode(query: string, commands: readonly Command[], onRun: (command: Command) => void): CommandMode {
  const listId = useId();
  const on = isCommandQuery(query);
  const text = commandText(query);
  const items = useMemo(() => (on ? filterCommands(query, commands) : []), [on, query, commands]);
  const [active, setActive] = useState(0);
  // A new filter starts at the top of the list.
  useEffect(() => setActive(0), [text, on]);
  const index = Math.min(active, Math.max(0, items.length - 1));
  const run = (command: Command | undefined) => {
    if (command) onRun(command);
  };
  return {
    on,
    items,
    active: index,
    setActive,
    listId,
    activeId: items[index] ? `${listId}-${index}` : undefined,
    run,
    onKeyDown(event) {
      if (!on) return false;
      const last = items.length - 1;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setActive(Math.min(index + 1, last));
          return true;
        case "ArrowUp":
          event.preventDefault();
          setActive(Math.max(index - 1, 0));
          return true;
        case "Enter":
          event.preventDefault();
          run(items[index]);
          return true;
        default:
          return false;
      }
    },
  };
}

/** The list of matching commands, each with its shortcut. */
export function CommandOptions({ mode }: { mode: CommandMode }) {
  const t = useStrings().keyboard.palette;
  return (
    <>
      <ul id={mode.listId} role="listbox" aria-label={t.commands} className="results">
        {mode.items.map((command, i) => (
          <li key={command.id} id={`${mode.listId}-${i}`} role="option" aria-selected={i === mode.active} className="result result-command" onMouseEnter={() => mode.setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => mode.run(command)}>
            <span>{command.title}</span>
            {command.shortcut && <kbd className="shortcut">{command.shortcut}</kbd>}
          </li>
        ))}
      </ul>
      {mode.items.length === 0 && (
        <p className="muted" role="status">
          {t.noCommands}
        </p>
      )}
    </>
  );
}
