/**
 * The Workflow Management Flow teaches what a notification may say, so a notification node in a
 * workflow being authored is checked against it on every level. The rules are read the way the
 * agent receives them: the engine reference WMF's bootstrap materializes into the workspace, and
 * the review directives rendered through the template processor. WMF's own upload-error decision
 * obeys the same authority rule as its upload question.
 */

import { describe, expect, test } from "@jest/globals";
import {
  GraphTemplateProcessor,
  renderMaterializeFiles,
  type ExecutionContext,
  type MaterializeNode,
} from "@mcp-moira/workflow-engine";
import { systemCatalogGraph } from "../../helpers/catalog-graphs.js";

const wmf = systemCatalogGraph("workflow-management-flow", "public");
const WORKSPACE = "./moira-ws/notification-rules";
const directive = (id: string): string =>
  (wmf.nodes.find((node) => node.id === id) as { directive: string }).directive;
const rendered = (id: string, variables: Record<string, unknown>): string =>
  new GraphTemplateProcessor().processDirective(directive(id), {
    executionId: "wmf-notification-rules",
    workflowId: "workflow-management-flow",
    userId: "rules",
    variables: { workspace_path: WORKSPACE, ...variables },
    nodeStates: {},
  });

async function engineReference(): Promise<string> {
  const node = wmf.nodes.find(
    (candidate) => candidate.id === "materialize-workspace-bootstrap",
  ) as MaterializeNode;
  const context: ExecutionContext = {
    executionId: "wmf-notification-rules",
    workflowId: "workflow-management-flow",
    userId: "rules",
    variables: { workspace_path: WORKSPACE },
    nodeStates: {},
  };
  const files = await renderMaterializeFiles(node, wmf.variableRegistry ?? {}, context);
  const engine = files.find((file) => file.path.endsWith("reference/engine.md"));
  expect(engine).toBeDefined();
  return engine!.content.toString();
}

describe("Workflow Management Flow teaches the notification content rules", () => {
  test.each([
    [
      "the heading is the engine's",
      "opens every message with the flow name and the run's task note,\n    linked to the run page; the message does not repeat them",
    ],
    [
      "the note comes from the first agent step",
      "through `execution_note` on its first agent step",
    ],
    [
      "the list comes from the binding",
      "The plan list comes from the list bound on the working block",
    ],
    ["full at plan ready and every finish", "`full` at plan ready and at every finish"],
    ["no hand-written list", "A\n    message never writes the list by hand"],
    ["no internal values", "No internal value reaches the reader"],
    [
      "reader lines from one-sentence fields",
      "a one-sentence field the step writes\n    for a person",
    ],
    [
      "enums worded",
      "an enum value\n    is worded through a template branch or by a message per outcome",
    ],
    [
      "interactive asks before, with explained choices",
      "An interactive run is told before the\n    question, with the choices explained in words",
    ],
    [
      "autonomous is never told a decision is pending",
      "An\n    autonomous run is never told that a decision is pending",
    ],
    [
      "one message after an autonomous decision",
      "one message with\n    what was decided and why, sent from the deciding node's own route",
    ],
    ["the last message goes straight to end", "The run's last message connects straight to `end`"],
    ["the deprecated node too", "The notification content rules above apply to it too"],
  ])("the materialized engine reference states that %s", async (_rule, text) => {
    expect(await engineReference()).toContain(text);
  });

  test("the light review on the simple level checks every notification against the reference it reads", () => {
    const text = rendered("review-workflow-minimum", { action_type: "create" });
    expect(text).toContain(`Read \`${WORKSPACE}/reference/engine.md\``);
    expect(text).toContain(
      `does every notification's message follow the notification content rules in \`${WORKSPACE}/reference/engine.md\`?`,
    );
    // The check is one of the questions the step must answer, and its completion condition says so.
    expect(text).toContain("Then answer four questions from the requirements and the JSON:");
    const review = wmf.nodes.find((node) => node.id === "review-workflow-minimum") as {
      completionCondition: string;
    };
    expect(review.completionCondition).toContain("notification content");
  });

  test("the full review on the standard and complex levels checks every notification against the reference it reads", () => {
    const text = rendered("review-workflow-quality", { complexity_tier: "standard" });
    expect(text).toContain(`\`${WORKSPACE}/reference/engine.md\``);
    expect(text).toContain(
      "every notification's message following the notification content rules of `reference/engine.md`",
    );
  });

  test("an autonomous upload-error decision never picks a non-standard method on its own", () => {
    const text = directive("handle-upload-error");
    expect(text).toContain("In `autonomous` mode do not ask");
    expect(text).toContain(
      "Never select `copy_new` or `admin_override` on your own: a non-standard method requires the user's explicit authorization of its observable semantics.",
    );
    // The same rule the upload question already carries.
    expect(directive("ask-upload")).toContain(
      "Never select `copy_new` or `admin_override` on your own: a non-standard method requires the user's explicit authorization of its observable semantics.",
    );
  });
});
