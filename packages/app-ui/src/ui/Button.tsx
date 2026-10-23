import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "quiet" | "danger";

/** Pill button: actions use pills, content uses Notion radii (design/DESIGN.md section 4). */
export function Button({ variant = "ghost", small, className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean }) {
  return <button type={type} className={["btn", `btn-${variant}`, small ? "btn-sm" : "", className ?? ""].filter(Boolean).join(" ")} {...rest} />;
}
