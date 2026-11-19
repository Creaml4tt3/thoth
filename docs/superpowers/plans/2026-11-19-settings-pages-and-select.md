# Settings pages and Thoth Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings shows one section at a time behind a wider, iconed side list, and every native `<select>` is replaced by one Thoth `Select`.

**Architecture:** `SettingsLayout` keeps its props and its search-everything filter, but turns the side list into a vertical tablist and hides every section except the chosen one while the search box is empty. A new `Select` (WAI-ARIA select-only combobox) in `@thoth/app-ui/ui` replaces the 19 native selects one file at a time.

**Tech Stack:** React 19, TypeScript, Vitest + Testing Library (jsdom), plain CSS with Papyrus Black tokens.

**Spec:** `docs/superpowers/specs/2026-11-19-settings-select-board-design.md` (Parts 1 and 2).

## Global Constraints

- Side list width **220 px** (from 160 px); below the existing narrow breakpoint the list sits above the content as a horizontal scrolling row.
- Section → icon: Appearance → half-moon, Editor → pen, Private Space → folder, Today → sun, Import & export → `import`, Servers → server, Agents → `sparkle`, Connected apps → plug, Notifications → `bell`, General → `gear`, Help & feedback → speech bubble. New icons drawn in `Icon.tsx` style: 24 grid, 1.8 stroke, round caps, `currentColor`.
- Default section: Appearance. Last chosen section remembered for the session only (module-level variable, not storage).
- Deep links `{ kind: "settings", section: "servers" | "agents" | "import" | "today" }` open that section's page.
- Select highlight is neutral `--thoth-bg-active`; no Moon wash (ADR-0053 amendment). Surface `--thoth-bg-container`, outline, menu radius and shadow as the existing menus.
- Every new user-facing string in `en.ts` and `th.ts`; Thai marked `// REVIEW`.
- CHANGELOG.md and CHANGELOG.th.md `[Unreleased]` get the same number of entries (a test checks).
- `pnpm check` passes before each commit that ends a task.

## Review Focus

- A deep link to a section whose component mounts late (Servers, Agents, Today load state first) must still land on that section, not on Appearance. Test in Task 2.
- Typing in Settings search, then clearing it, returns to the section that was chosen before, not to the first hit. Test in Task 2.
- A `Select` inside a `Modal` (TransferDialog, MoveToDialog, MembersDialog): Escape closes the listbox only, not the dialog. Test in Task 4.
- A `Select` near the bottom of the window opens upward and stays inside the window. Test in Task 3.
- Thai type-ahead: typing "ไ" jumps to the first option starting with "ไ". Test in Task 3.

---

### Task 1: Settings icons

**Files:**
- Modify: `packages/app-ui/src/ui/Icon.tsx` (add names and drawings)
- Modify: `packages/app-ui/src/ui/SettingsLayout.tsx:5-9` (`SettingsSectionLink`)
- Modify: `apps/desktop/src/features/settings/SettingsView.tsx:72-84`, `apps/web/src/SettingsView.tsx:15-…`
- Test: `packages/app-ui/test/icon.test.tsx` (create if absent)

**Interfaces:**
- Produces: `IconName` gains `"moon" | "pen" | "folder" | "sun" | "server" | "plug" | "speech"`. `SettingsSectionLink` becomes `{ id: string; label: string; icon: IconName }`.

- [ ] **Step 1: Write the failing test** `every IconName draws something`: render `<Icon name={n} />` for each of the 7 new names; assert the `svg` has at least one child element.
- [ ] **Step 2: Run** `pnpm vitest run packages/app-ui/test/icon.test.tsx` — Expected: FAIL (type error / unknown name).
- [ ] **Step 3: Add the 7 drawings** to `DRAWINGS` in `Icon.tsx`, each with a one-line `/** … */` like the existing ones. Add `icon` to `SettingsSectionLink`, render `<Icon name={x.icon} />` before the label in the nav, and pass icons from both `SettingsView`s per the Global Constraints mapping.
- [ ] **Step 4: Run** the icon test and `pnpm vitest run packages/app-ui/test/settings-layout.test.tsx` — Expected: PASS (update the test's `sections` fixtures to include `icon`).
- [ ] **Step 5: Commit** `feat(settings): an icon for each section`.

### Task 2: One section at a time

**Files:**
- Modify: `packages/app-ui/src/ui/SettingsLayout.tsx` (whole component)
- Modify: `packages/app-ui/src/editor.css:122-129` (layout width, tab styles, narrow row)
- Modify: `apps/desktop/src/features/settings/SettingsView.tsx`, `DailySettings.tsx:44`, `apps/desktop/src/features/servers/ServersSettings.tsx:252`, `apps/desktop/src/features/agents/AgentSettings.tsx` (replace `scrollToSection` on `focus` with choosing the section)
- Modify: `packages/app-ui/src/strings/en.ts`, `th.ts` (tablist label if a new one is needed)
- Test: `packages/app-ui/test/settings-layout.test.tsx` (rewrite the scroll tests), `apps/desktop/test/settings*.test.tsx` (update)

**Interfaces:**
- Consumes: `SettingsSectionLink` with `icon` (Task 1).
- Produces: `SettingsLayout({ sections, initial?: string, children })` where `initial` is a heading id to open first (deep link). `scrollToSection` stays exported (still used by search results) but sections no longer call it for deep links. Each settings section component gets its open request from `initial` instead of `focus` scrolling.

- [ ] **Step 1: Write the failing tests** in `settings-layout.test.tsx`:
  - `shows only the chosen section`: three sections; only Appearance is visible (`not.toHaveAttribute("hidden")`), the others `hidden`.
  - `the list is a vertical tablist`: `getByRole("tablist")` has `aria-orientation="vertical"`; each tab `aria-selected` matches; each section has `role="tabpanel"` and `aria-labelledby` = its tab's id.
  - `arrow keys move between tabs and choose them`: focus tab 1, ArrowDown → tab 2 focused and its panel shown; Home/End go to first/last.
  - `initial opens that section, even when it appears late`: render with `initial="set-servers"` and add the Servers section after a tick; expect Servers' panel shown.
  - `search shows matches from every section, and clearing returns to the chosen one`: choose Editor, type a word only in Servers → Servers' matching part visible; clear (Escape) → Editor shown again, Servers hidden.
  - `the last chosen section is remembered for the session`: choose Editor, unmount, mount again → Editor shown.
- [ ] **Step 2: Run** `pnpm vitest run packages/app-ui/test/settings-layout.test.tsx` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Replace the `nav > a` list with `<div role="tablist" aria-orientation="vertical">` of buttons (roving tabindex). While `query` is empty, set `hidden` on every `:scope > section` except the chosen one (and `role="tabpanel"`, `aria-labelledby`); while `query` has text, keep today's filter unchanged. Remove the `IntersectionObserver` "section in view" logic and the `held` ref (no scrolling list any more). Chosen id: `initial` when it is present in `present`, else the session value, else the first present section; keep it in a module-level `let lastChosen: string | null`. CSS: `.settings-layout { grid-template-columns: 220px minmax(0, var(--thoth-content-width)); }`; tab rows use `--thoth-bg-hover` / `--thoth-bg-active` (neutral); in the existing narrow container query the tablist becomes `display:flex; overflow-x:auto` above the content.
- [ ] **Step 4: Wire deep links.** `SettingsView` maps its `section` prop to `initial`: `servers → "set-servers"`, `agents → "set-agents"`, `import → "set-import"`, `today → "set-today"`, `top → undefined`. Remove the `focus` → `scrollToSection` effects in `DailySettings`, `ServersSettings`, `AgentSettings`; keep their other `focus` behaviour (e.g. Import still starts the wizard). Web `SettingsView` passes no `initial`.
- [ ] **Step 5: Run** `pnpm vitest run packages/app-ui/test/settings-layout.test.tsx apps/desktop/test` — Expected: PASS. Fix desktop tests that asserted scrolling to assert the chosen tab instead.
- [ ] **Step 6: Commit** `feat(settings): one section per page, wider list`.

### Task 3: Thoth Select component

**Files:**
- Create: `packages/app-ui/src/ui/Select.tsx`
- Modify: `packages/app-ui/src/ui.css` (select button + listbox styles)
- Test: `packages/app-ui/test/select.test.tsx`, `packages/app-ui/test/contrast.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SelectOption<V extends string> { value: V; label: string; description?: string; disabled?: boolean }
  export function Select<V extends string>(props: {
    value: V; onChange(value: V): void; options: readonly SelectOption<V>[];
    id?: string; name?: string; disabled?: boolean; className?: string;
    "aria-label"?: string; "aria-labelledby"?: string; "aria-describedby"?: string;
  }): JSX.Element
  ```
  The button has `role="combobox"`, `aria-haspopup="listbox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant` while open; the list is `role="listbox"` rendered into `shellRoot()` (from `order/ContextMenu.tsx`) with `role="option"` + `aria-selected`.

- [ ] **Step 1: Write the failing tests** in `select.test.tsx`:
  - `shows the chosen label`; `opens on Enter, Space and Alt+ArrowDown`; `ArrowDown/Up/Home/End move the active option and skip disabled ones`; `Enter chooses and closes, focus stays on the button`; `Escape closes without changing and does not reach a parent keydown listener` (assert a parent `onKeyDown` spy is not called); `Tab chooses the active option and closes`; `click outside closes`; `type-ahead jumps by first letter, Thai included` (options "กา", "ไก่", "ขา"; type "ไ" → "ไก่" active); `opens upward when there is no room below` (stub `getBoundingClientRect` of the button near the bottom of a 600 px window; expect the listbox's `data-side="top"`); `disabled select does not open`.
- [ ] **Step 2: Run** `pnpm vitest run packages/app-ui/test/select.test.tsx` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement `Select`** per the interface. Position with the same helper the context menu uses (`ui/place.ts`), flip above when below is short. Type-ahead: a 500 ms buffer compared with `searchable()` from `SettingsLayout.tsx` on each label's start. Reduced motion (`motionOff()`): no open animation. Forced colours: rely on system colours like `.context-menu`.
- [ ] **Step 4: Add contrast pairs** to `contrast.test.ts`: option text (`--thoth-ink-primary`) on `--thoth-bg-container`; active option text on `--thoth-bg-active` over container; disabled option (`--thoth-ink-tertiary`) on container ≥ 3:1 — light and dark.
- [ ] **Step 5: Run** `pnpm vitest run packages/app-ui/test/select.test.tsx packages/app-ui/test/contrast.test.ts` — Expected: PASS.
- [ ] **Step 6: Commit** `feat(ui): Thoth Select, a select-only combobox`.

### Task 4: Replace every native select

**Files (modify):** `apps/desktop/src/features/agents/AgentSettings.tsx` (4), `apps/desktop/src/features/mascot/Bubble.tsx` (4), `packages/app-ui/src/transfer/TransferDialog.tsx` (3), `apps/desktop/src/features/settings/SettingsView.tsx` (2), `apps/desktop/src/features/connected-apps/MemoriesView.tsx`, `packages/app-ui/src/order/MoveToDialog.tsx`, `packages/app-ui/src/timeline/TimelineView.tsx`, `packages/app-ui/src/workspace/MembersDialog.tsx`, `apps/web/src/LanguageSwitch.tsx`, `apps/web/src/ThemeSwitch.tsx`, plus their tests and `CHANGELOG.md` / `CHANGELOG.th.md`.

**Interfaces:**
- Consumes: `Select` (Task 3).

- [ ] **Step 1: Add a guard test** `tests/repo/no-native-select.test.ts`: read every `.tsx` under `apps/*/src` and `packages/*/src`; expect none to contain `<select`. Run it — Expected: FAIL listing the 10 files.
- [ ] **Step 2: Add the Modal Escape test** to `packages/app-ui/test/transfer-dialog.test.tsx` (or the closest existing dialog test): open a `Select` inside the dialog, press Escape → listbox closed, dialog still open; press Escape again → dialog closes.
- [ ] **Step 3: Replace** each `<select>` with `<Select>`, keeping its label association (`aria-labelledby` to the visible label's id, or `aria-label`), its `value`/`onChange` and disabled state. Tests that used `userEvent.selectOptions` switch to opening the combobox and clicking `getByRole("option", { name })`.
- [ ] **Step 4: Changelog** (Changed, one line each language, Thai `<!-- REVIEW -->`): "Settings shows one section at a time, with a wider list and an icon for each section." and "Dropdowns look like the rest of Thoth instead of your system's."
- [ ] **Step 5: Run** `pnpm check` — Expected: exit 0.
- [ ] **Step 6: Commit** `feat(ui): every dropdown is a Thoth Select`.
