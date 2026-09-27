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
  checkChoice,
  checkConnected,
  checkNewStep,
  checkOwnCopy,
  checkReference,
  renameNode,
  setChoice,
  setConnection,
  TUTORIAL_EXAMPLE_IDS,
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

/** Lesson 4 done on top of lesson 3: `check-result` asks whether the result matches. */
function withChoice(example: WorkflowGraph, text = { gap: "Explain what is missing." }) {
  let graph = connected(example);
  graph = addNode(
    graph,
    {
      id: "explain-gap",
      type: "agent-directive",
      directive: text.gap,
      completionCondition: text.gap,
    } as never,
    { blockId: "check" },
  );
  graph = setConnection(graph, "explain-gap", "success", "end");
  (
    graph.nodes.find((node) => node.id === "explain-gap") as { connectionLabels?: unknown }
  ).connectionLabels = { success: "gap explained" };
  return setChoice(graph, "check-result", {
    field: "matches",
    question: "Does the result match?",
    options: ["yes", "no"],
    defaultOption: "yes",
    targets: { no: "explain-gap" },
    labels: { yes: "result checked", no: "something is missing" },
  });
}

/** Lesson 5 done on top of lesson 4: the report repeats the task as the agent restated it. */
function withReference(example: WorkflowGraph, words = "Repeat the task:") {
  const graph = withChoice(example);
  const report = graph.nodes.find((node) => node.id === "report") as { directive: string };
  report.directive = `${words} {{understand-task.task}}`;
  return graph;
}

describe.each(["example-simple-steps", "example-simple-steps-ru"])("lessons 4–5 on %s", (slug) => {
  const example = () => catalogGraph(slug);

  test("lesson 4 fails before the choice and passes with it", () => {
    const before = connected(example());
    expect(codes(checkChoice(before, issues(before)))).toEqual(["choice-field-missing"]);
    const after = withChoice(example());
    expect(checkChoice(after, issues(after))).toEqual({ passed: true, findings: [] });
  });

  test("lesson 4 names a case comparing a value the answer does not offer", () => {
    const graph = withChoice(example());
    const step = graph.nodes.find((node) => node.id === "check-result") as {
      cases: Array<{ when: { right: string } }>;
    };
    step.cases[0].when.right = "maybe";
    expect(codes(checkChoice(graph, issues(graph)))).toContain("case-compares-value-not-offered");
  });

  test("lesson 4 names a `no` route that loops back to the check", () => {
    let graph = withChoice(example());
    graph = setConnection(graph, "explain-gap", "success", "do-task");
    expect(codes(checkChoice(graph, issues(graph)))).toContain("choice-loops-back");
  });

  test("lesson 5 passes on a reference to the restated task, whatever the words around it", () => {
    expect(checkReference(withReference(example()), 0)).toEqual({ passed: true, findings: [] });
  });

  test.each([
    [
      "a misspelt field",
      (graph: WorkflowGraph) => {
        (graph.nodes.find((n) => n.id === "report") as { directive: string }).directive =
          "Repeat {{understand-task.tsk}}";
      },
      "reference-field-not-declared",
    ],
    [
      "a reference to a step that runs later",
      (graph: WorkflowGraph) => {
        (graph.nodes.find((n) => n.id === "report") as { directive: string }).directive = "Report.";
        (graph.nodes.find((n) => n.id === "understand-task") as { directive: string }).directive =
          "Restate {{report.report}}";
      },
      "reference-not-before-use",
    ],
    [
      "the task mentioned in words without a reference",
      (graph: WorkflowGraph) => {
        (graph.nodes.find((n) => n.id === "report") as { directive: string }).directive =
          "Repeat the task as understand-task restated it.";
      },
      "reference-missing",
    ],
  ])("lesson 5 fails on %s", (_name, change, code) => {
    const graph = withReference(example());
    change(graph);
    expect(codes(checkReference(graph, 0))).toEqual([code]);
  });

  test("lesson 5 waits while validation errors remain", () => {
    expect(codes(checkReference(withReference(example()), 2))).toEqual(["validation-errors"]);
  });

  test("renaming the new step keeps lessons 3 to 5 passing", () => {
    const renamed = renameNode(withReference(example()), "save-draft", "keep-a-draft").workflow;
    expect(checkConnected(renamed, example(), issues(renamed)).passed).toBe(true);
    expect(checkChoice(renamed, issues(renamed)).passed).toBe(true);
    expect(checkReference(renamed, 0).passed).toBe(true);
  });
});

test("the text's language does not change a result: English words in the Russian copy, Russian in the English", () => {
  const results = (graph: WorkflowGraph, example: WorkflowGraph) => [
    checkConnected(graph, example, issues(graph)),
    checkChoice(graph, issues(graph)),
    checkReference(graph, 0),
  ];
  const en = catalogGraph("example-simple-steps");
  const ru = catalogGraph("example-simple-steps-ru");
  const englishInRussian = withReference(ru, "Repeat the task:");
  const russianInEnglish = withReference(en, "Повторите задачу:");
  expect(results(englishInRussian, ru)).toEqual(
    results(withReference(ru, "Повторите задачу:"), ru),
  );
  expect(results(russianInEnglish, en)).toEqual(results(withReference(en, "Repeat the task:"), en));
  expect(results(englishInRussian, ru).every((result) => result.passed)).toBe(true);
});

test.each(["example-simple-steps", "example-simple-steps-ru"])(
  "%s keeps every step and block id the tutorial names",
  (slug) => {
    const graph = catalogGraph(slug);
    expect(graph.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([...TUTORIAL_EXAMPLE_IDS.nodes]),
    );
    expect((graph.progress?.nodes ?? []).map((block) => block.id)).toEqual(
      expect.arrayContaining([...TUTORIAL_EXAMPLE_IDS.blocks]),
    );
  },
);
