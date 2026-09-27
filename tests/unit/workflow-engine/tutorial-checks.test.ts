/**
 * The checks of the tutorial "Build your first flow" on the catalog's learning example and its
 * Russian twin: an untouched copy fails each building lesson with its code, a correct change passes,
 * a change that is structurally wrong fails whatever its text says, an unreachable new step fails,
 * and renaming the new step changes nothing. The same edits, in either language, give the same
 * results.
 */

import { describe, expect, test } from "@jest/globals";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { deriveProcess } from "@mcp-moira/workflow-engine/process";
import {
  addNode,
  checkConnected,
  checkNewStep,
  checkOwnCopy,
  renameNode,
  setConnection,
} from "@mcp-moira/workflow-engine/authoring";
import type { GraphNode } from "@mcp-moira/workflow-engine/types";
import { catalogGraph } from "../../helpers/catalog-graphs.js";

const codes = (result: { findings: Array<{ code: string }> }) =>
  result.findings.map((finding) => finding.code);
const issues = (graph: WorkflowGraph) => deriveProcess(graph)?.diagnostics ?? [];

/** A step as a person would add it; its text claims whatever the test passes in. */
const draftStep = (id: string, directive = "Save a draft of the work.") =>
  ({
    id,
    type: "agent-directive",
    directive,
    completionCondition: "A draft is saved.",
  }) as unknown as GraphNode;

/** The example with a step added to the Do block and connected between `do-task` and the check. */
function connected(example: WorkflowGraph, id = "save-draft"): WorkflowGraph {
  let graph = addNode(example, draftStep(id), { blockId: "work" });
  graph = setConnection(graph, "do-task", "success", id);
  graph = setConnection(graph, id, "success", "check-result");
  const step = graph.nodes.find((node) => node.id === id) as { connectionLabels?: unknown };
  step.connectionLabels = { success: "draft saved" };
  return graph;
}

describe.each(["example-simple-steps", "example-simple-steps-ru"])("on %s", (slug) => {
  const example = () => catalogGraph(slug);

  test("lesson 1 holds for a private copy the reader owns, and names what is wrong otherwise", () => {
    expect(
      checkOwnCopy(example(), example(), { visibility: "private", ownedByReader: true }),
    ).toEqual({ passed: true, findings: [] });
    const changed = setConnection(example(), "do-task", "success", "report");
    expect(
      codes(checkOwnCopy(changed, example(), { visibility: "public", ownedByReader: false })),
    ).toEqual(["copy-not-owned", "copy-not-private", "copy-structure-differs"]);
  });

  test("lesson 2 fails on the untouched copy and passes once a filled step is in a block", () => {
    expect(codes(checkNewStep(example(), example()))).toEqual(["new-step-missing"]);
    const added = addNode(example(), draftStep("save-draft"), { blockId: "work" });
    expect(checkNewStep(added, example())).toEqual({ passed: true, findings: [] });
  });

  test("lesson 2 fails on a step whose text claims to be done but whose fields are empty", () => {
    const claimed = addNode(
      example(),
      {
        id: "done-step",
        type: "agent-directive",
        directive: "  ",
        completionCondition: "",
      } as never,
      { blockId: "work" },
    );
    expect(checkNewStep(claimed, example()).findings).toEqual([
      { code: "new-step-directive-empty", nodeId: "done-step", field: "directive" },
      { code: "new-step-condition-empty", nodeId: "done-step", field: "completionCondition" },
    ]);
  });

  test("lesson 3 fails on a new step left unreachable, and passes once it is connected and labelled", () => {
    const added = addNode(example(), draftStep("save-draft"), { blockId: "work" });
    const unconnected = checkConnected(added, example(), issues(added));
    expect(codes(unconnected)).toEqual(
      expect.arrayContaining([
        "new-step-not-connected",
        "new-step-not-continuing",
        "unreachable-node",
      ]),
    );
    const done = connected(example());
    expect(checkConnected(done, example(), issues(done))).toEqual({ passed: true, findings: [] });
  });

  test("lesson 3 fails when the connection's text says it is done but the structure is not", () => {
    // Connected into the step, but on to the report rather than the check.
    let wrong = addNode(example(), draftStep("save-draft", "Connected to check-result."), {
      blockId: "work",
    });
    wrong = setConnection(wrong, "do-task", "success", "save-draft");
    wrong = setConnection(wrong, "save-draft", "success", "report");
    expect(codes(checkConnected(wrong, example(), issues(wrong)))).toContain(
      "new-step-not-continuing",
    );
  });

  test("lesson 3 names the label a connection into another block needs", () => {
    const unlabelled = connected(example());
    delete (
      unlabelled.nodes.find((node) => node.id === "save-draft") as { connectionLabels?: unknown }
    ).connectionLabels;
    expect(checkConnected(unlabelled, example(), issues(unlabelled)).findings).toContainEqual({
      code: "edge-needs-label",
      nodeId: "save-draft",
      field: "success",
    });
  });

  test("renaming the new step keeps lessons 2 and 3 passing", () => {
    const renamed = renameNode(connected(example()), "save-draft", "keep-a-draft").workflow;
    expect(checkNewStep(renamed, example()).passed).toBe(true);
    expect(checkConnected(renamed, example(), issues(renamed)).passed).toBe(true);
  });
});
