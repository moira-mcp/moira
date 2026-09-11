/**
 * `derive` — print a workflow's process projection: its blocks in process order, the authored
 * nodes each owns, its labelled transitions and explained returns, and every diagnostic the
 * block contract raises. The output is deterministic plain text so an author can read the
 * aggregated view of a flow without a browser and a review gate can diff it.
 */

// Import the derivation directly: the package index pulls in shared auth configuration, which the
// CLI must not require (it runs without the server environment).
import { deriveProcess, type ProcessProjection } from "@mcp-moira/workflow-engine/process";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

function line(indent: number, text: string): string {
  return `${"  ".repeat(indent)}${text}`;
}

export function formatProcessProjection(
  workflow: Pick<WorkflowGraph, "metadata">,
  projection: ProcessProjection,
): string {
  const out: string[] = [];
  const cycles = projection.blocks.reduce(
    (n, b) => n + b.transitions.filter((t) => t.cycle).length,
    0,
  );
  const transitions = projection.blocks.reduce((n, b) => n + b.transitions.length, 0);
  out.push(
    `PROCESS ${workflow.metadata.name} v${workflow.metadata.version}: ${projection.blocks.length} blocks, ${transitions} transitions, ${cycles} returns, ${projection.diagnostics.length} diagnostics`,
  );
  const names = new Map(projection.blocks.map((b) => [b.id, b.label]));
  projection.blocks.forEach((block, i) => {
    const hub = projection.hubs.includes(block.id) ? " [hub]" : "";
    out.push(line(1, `BLOCK ${i + 1}. ${block.id} — ${block.label}${hub}`));
    out.push(line(2, `description: ${block.description || "(missing)"}`));
    if (block.outcome) out.push(line(2, `outcome: ${block.outcome}`));
    out.push(line(2, `nodes (${block.nodeIds.length}): ${block.nodeIds.join(", ") || "(none)"}`));
    for (const t of block.transitions) {
      const target = names.get(t.to) ?? t.to;
      if (t.cycle) {
        out.push(line(2, `RETURN → ${t.to} (${target}): ${t.label}`));
        out.push(line(3, `cause: ${t.cycle.cause}`));
        out.push(line(3, `ends when: ${t.cycle.exit || "(missing)"}`));
      } else {
        out.push(line(2, `NEXT → ${t.to} (${target}): ${t.label}`));
      }
      out.push(line(3, `edges: ${t.edges.join(", ")}`));
    }
  });
  if (projection.diagnostics.length) {
    out.push("DIAGNOSTICS");
    for (const d of projection.diagnostics) {
      const where = d.nodeId ? ` node=${d.nodeId}` : d.blockId ? ` block=${d.blockId}` : "";
      out.push(line(1, `${d.code}${where}${d.edge ? ` edge=${d.edge}` : ""}: ${d.message}`));
    }
  } else {
    out.push("DIAGNOSTICS: none");
  }
  return out.join("\n");
}

/** Render the derivation of a workflow, or explain that it has no progress definition. */
export function renderWorkflowDerivation(workflow: WorkflowGraph): string {
  const projection = deriveProcess(workflow);
  if (!projection) {
    return `PROCESS ${workflow.metadata.name} v${workflow.metadata.version}: no progress definition — this workflow has no block view.`;
  }
  return formatProcessProjection(workflow, projection);
}
