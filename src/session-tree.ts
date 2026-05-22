import type { SessionNode, TraceEvent } from "./process.js";

export function sessionTreeToMarkdown(
  nodes: SessionNode[],
  depth = 0
): string {
  const indent = "  ".repeat(depth);
  let md = "";

  for (const node of nodes) {
    const status = node.events.some((e: TraceEvent) => e.type === "error")
      ? "error"
      : node.events.some((e: TraceEvent) => e.type === "done")
        ? "done"
        : "running";

    md += `${indent}- **${node.name}** (${node.runId}) [${status}]\n`;

    const branches = node.events.filter(
      (e: TraceEvent) => e.type === "branch"
    );
    for (const b of branches) {
      if (b.type === "branch") {
        md += `${indent}  - Branch: chose "${b.chosen}" from [${b.alternatives.join(", ")}]\n`;
      }
    }

    const fixes = node.events.filter(
      (e: TraceEvent) =>
        e.type === "fix_start" || e.type === "fix_end"
    );
    for (const f of fixes) {
      if (f.type === "fix_start") {
        md += `${indent}  - Fix started: ${f.reason}\n`;
      }
    }

    if (node.children.length > 0) {
      md += sessionTreeToMarkdown(node.children, depth + 1);
    }
  }

  return md;
}
