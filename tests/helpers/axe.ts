/**
 * axe-core in jsdom for component tests: every rule except the ones jsdom cannot judge (colour contrast needs layout
 * and real styles; `region` is about a whole page, not one dialog). Returns the violations as readable lines.
 */
import axe from "axe-core";

export async function axeViolations(node: Element): Promise<string[]> {
  const results = await axe.run(node, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } }, resultTypes: ["violations"] });
  return results.violations.map((v) => `${v.id} (${v.impact ?? "?"}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}
