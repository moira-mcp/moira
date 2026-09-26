/**
 * Acceptance 7 of the standard flows' notifications, held across the whole catalogue: no
 * notification attaches the progress picture, and only the Software Development Flow links its
 * reports. Every other link a standard flow could send is the run page, which the engine heading
 * already carries. A link is a literal URL in the message or an interpolated value that is a URL:
 * named as one, or declared with a URL pattern or format by the step or registry that writes it.
 */

import { describe, expect, test } from "@jest/globals";
import {
  inlineGlobalInputs,
  type AgentDirectiveNode,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { systemCatalogGraph } from "../helpers/catalog-graphs.js";

const STANDARD = [
  "todo-list",
  "quick-task",
  "robust-task",
  "workflow-management-flow",
  "software-development-flow",
] as const;
const graph = (slug: string) => systemCatalogGraph(slug, "public");

type Field = { pattern?: string; format?: string };
type Notification = { id: string; type: string; message?: string; attachProgressImage?: boolean };

const isUrlField = (name: string, field: Field | undefined): boolean =>
  /(?:url|link)$/iu.test(name) ||
  Boolean(field?.pattern?.includes("http")) ||
  field?.format === "uri" ||
  field?.format === "url";

/** The field a template reference reads: a node output (`node.field`) or a registry variable. */
function fieldOf(workflow: WorkflowGraph, reference: string): Field | undefined {
  const [head, ...rest] = reference.split(".");
  if (rest.length === 0) {
    return (workflow.variableRegistry?.[head] as { schema?: Field } | undefined)?.schema;
  }
  const node = workflow.nodes.find((candidate) => candidate.id === head);
  if (node?.type !== "agent-directive") return undefined;
  const schema = (inlineGlobalInputs(node, workflow.variableRegistry) as AgentDirectiveNode)
    .inputSchema as { properties?: Record<string, Field> } | undefined;
  return schema?.properties?.[rest.join(".")];
}

/** Each notification that links something other than the run page, with what it links. */
function foreignLinks(workflow: WorkflowGraph): string[] {
  const found: string[] = [];
  for (const node of workflow.nodes as unknown as Notification[]) {
    if (!/notification$/u.test(node.type) || !node.message) continue;
    for (const literal of node.message.match(/https?:\/\/\S+/gu) ?? []) {
      found.push(`${node.id}: ${literal}`);
    }
    for (const [, expression] of node.message.matchAll(/\{\{\s*([\w.[\]-]+)\s*\}\}/gu)) {
      if (expression === "runUrl") continue;
      const name = expression.split(".").at(-1)!;
      if (isUrlField(name, fieldOf(workflow, expression)))
        found.push(`${node.id}: {{${expression}}}`);
    }
  }
  return found;
}

describe("standard flows: no notification picture, and only SDF links its reports", () => {
  test.each(STANDARD)("no node of %s attaches the progress picture", (slug) => {
    expect(
      (graph(slug).nodes as unknown as Notification[])
        .filter((node) => node.attachProgressImage)
        .map((node) => node.id),
    ).toEqual([]);
  });

  test.each(STANDARD.filter((slug) => slug !== "software-development-flow"))(
    "no notification of %s links anything but the run",
    (slug) => {
      expect(foreignLinks(graph(slug))).toEqual([]);
    },
  );

  test("SDF's report links are exactly the links the rule recognizes", () => {
    expect(foreignLinks(graph("software-development-flow")).sort()).toEqual([
      "notify-final-approval: {{create-final-report.final_report_url}}",
      "notify-report-ready: {{create-and-upload-step-report.report_url}}",
      "notify-unit-approval-report: {{create-and-upload-step-report.report_url}}",
      "notify-workflow-complete: {{create-final-report.final_report_url}}",
    ]);
  });

  test.each([
    ["a literal link", "https://example.org/report", ["https://example.org/report"]],
    ["a value named as a URL", "{{report_url}}", ["{{report_url}}"]],
    ["a step output declared as a URL", "{{get-task.delivered_at}}", ["{{get-task.delivered_at}}"]],
    ["the run page", "{{runUrl}}", []],
  ])("in Quick Task, %s in a message is told apart", (_kind, added, expected) => {
    const copy = structuredClone(graph("quick-task"));
    // A step output whose name says nothing, but whose contract is a URL.
    const task = copy.nodes.find((node) => node.id === "get-task") as unknown as {
      inputSchema: { properties: Record<string, Field> };
    };
    task.inputSchema.properties.delivered_at = { pattern: "^https?://" };
    const node = (copy.nodes as unknown as Notification[]).find(
      (candidate) => candidate.id === "notify-result-ready",
    )!;
    node.message += `\n\n${added}`;
    expect(foreignLinks(copy)).toEqual(expected.map((link) => `notify-result-ready: ${link}`));
  });
});
