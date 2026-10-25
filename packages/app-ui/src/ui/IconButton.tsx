import type { ButtonHTMLAttributes, Ref } from "react";
import { tip } from "./Tooltip.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { useShortcutHint } from "../keyboard/hints.ts";
import type { ShortcutId } from "../keyboard/shortcuts.ts";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  icon: IconName;
  /** The accessible name, and the first line of the tooltip. */
  label: string;
  /** The command it runs, if the shortcut table has one: its keys show in the tooltip and are announced (`aria-keyshortcuts`). */
  shortcut?: ShortcutId | undefined;
  ref?: Ref<HTMLButtonElement>;
}

/** A 28px icon button: always named (`aria-label`), with a tooltip that shows the name and the shortcut. */
export function IconButton({ icon, label, shortcut, className, type = "button", ...rest }: Props) {
  const hint = useShortcutHint(shortcut ?? "palette.open");
  const keys = shortcut ? hint : null;
  return (
    <button type={type} className={["icon-btn", className ?? ""].filter(Boolean).join(" ")} aria-label={label} {...(keys ? { "aria-keyshortcuts": keys.aria } : {})} {...tip(label, keys?.keys)} {...rest}>
      <Icon name={icon} />
    </button>
  );
}
