/**
 * The beginner example flows: three levels, each shipped in English and in Russian.
 *
 * They exist to be read at a glance, so their simplicity is a contract, not a style: no template
 * reference in any text the agent receives, no loop anywhere in the graph, no global variable, and
 * every fork decided by one answer of the step that asks. The two language versions of a level are
 * the same process: same steps, same routing, same answer schema — only the words differ. Every
 * branch of every flow runs to its own end through the real engine.
 */

import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import { GraphValidator, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { deriveProcess, findBackEdges } from "@mcp-moira/workflow-engine/process";
import { runScenario } from "../../helpers/scenario-runner.js";

type AnyNode = Record<string, any>;

const LEVELS = ["example-simple-steps", "example-one-choice", "example-several-paths"] as const;
const SLUGS = LEVELS.flatMap((slug) => [slug, `${slug}-ru`]);

function load(slug: string): WorkflowGraph {
  const entry = findCatalogEntryBySlug(slug);
  expect(entry).toBeDefined();
  return structuredClone(entry!.graph) as unknown as WorkflowGraph;
}

function nodesOf(workflow: WorkflowGraph): AnyNode[] {
  return workflow.nodes as unknown as AnyNode[];
}

/** The language-free shape of a flow: everything but the words. */
function structure(workflow: WorkflowGraph): unknown {
  const stripDescriptions = (schema: AnyNode | undefined): unknown =>
    schema && {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([name, property]) => {
          const { description: _description, ...rest } = property as AnyNode;
          return [name, rest];
        }),
      ),
    };
  return {
    nodes: nodesOf(workflow).map((node) => ({
      id: node.id,
      type: node.type,
      connections: node.connections ?? null,
      connectionLabelKeys: Object.keys(node.connectionLabels ?? {}).sort(),
      cases: node.cases ?? null,
      inputSchema: stripDescriptions(node.inputSchema) ?? null,
      progressNodeId: node.progressNodeId,
    })),
    blocks: workflow.progress?.nodes.map((block) => block.id),
    registry: workflow.variableRegistry,
  };
}

describe("beginner example flows", () => {
  test.each(SLUGS)("%s validates and derives a process with no diagnostics", async (slug) => {
    const workflow = load(slug);
    const validation = await new GraphValidator().validateUnified(workflow);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(deriveProcess(workflow as never)?.diagnostics).toEqual([]);
  });

  test.each(SLUGS)("%s stays simple: no templates, no loops, no globals", (slug) => {
    const workflow = load(slug);
    const texts = nodesOf(workflow).flatMap((node) => [
      node.directive,
      node.completionCondition,
      ...Object.values(node.connectionLabels ?? {}),
    ]);
    expect(texts.filter((text) => typeof text === "string" && text.includes("{{"))).toEqual([]);
    expect([...findBackEdges(workflow.nodes as never, "start")]).toEqual([]);
    expect(workflow.variableRegistry).toEqual({});
    for (const node of nodesOf(workflow)) {
      expect(node.inputSchema?.globalInputs).toBeUndefined();
      expect(node.expressions).toBeUndefined();
      for (const routingCase of node.cases ?? []) {
        // A fork reads exactly one answer field of the step that asks it.
        expect(routingCase.when.operator).toBe("eq");
        expect(routingCase.when.left.contextPath).toMatch(new RegExp(`^${node.id}\\.[a-z]+$`));
        expect(Object.keys(node.inputSchema.properties)).toEqual([
          routingCase.when.left.contextPath.split(".")[1],
        ]);
      }
    }
  });

  test.each(LEVELS)("%s has the same process in English and in Russian", (slug) => {
    const english = load(slug);
    const russian = load(`${slug}-ru`);
    expect(structure(russian)).toEqual(structure(english));
    expect(english.metadata.name).not.toEqual(russian.metadata.name);
  });

  const branches: Array<[string, string, Record<string, Record<string, string>>, string[]]> = [
    [
      "example-simple-steps",
      "end",
      {
        "understand-task": { task: "Rename the file" },
        "do-task": { result: "Renamed it" },
        "check-result": { check: "Listed the folder" },
        report: { report: "Renamed the file and checked the folder" },
      },
      [],
    ],
    [
      "example-one-choice",
      "end-done",
      {
        "do-task": { result: "Wrote the note" },
        "check-result": { matches: "yes" },
        report: { report: "Wrote the note" },
      },
      ["explain-gap"],
    ],
    [
      "example-one-choice",
      "end-gap",
      {
        "do-task": { result: "Wrote half of the note" },
        "check-result": { matches: "no" },
        "explain-gap": { report: "The second half needs data I do not have" },
      },
      ["report", "end-done"],
    ],
    [
      "example-several-paths",
      "end-answered",
      { "sort-request": { kind: "question" }, "answer-question": { answer: "Yes, see the docs" } },
      ["fix-bug", "plan-idea"],
    ],
    [
      "example-several-paths",
      "end-fixed",
      { "sort-request": { kind: "bug" }, "fix-bug": { fix: "Fixed the typo and reran it" } },
      ["answer-question", "plan-idea"],
    ],
    [
      "example-several-paths",
      "end-planned",
      { "sort-request": { kind: "idea" }, "plan-idea": { plan: "Three steps; go ahead?" } },
      ["answer-question", "fix-bug"],
    ],
  ];

  describe.each(["", "-ru"])("every branch runs to its own end (suffix '%s')", (suffix) => {
    test.each(branches)("%s ends at %s", async (slug, end, answers, avoided) => {
      const result = await runScenario(load(`${slug}${suffix}`), {
        name: `${slug}${suffix} → ${end}`,
        mockInputs: answers,
        expect: { status: "completed", reaches: [end], avoids: avoided },
      });
      expect(result.status).toBe("completed");
      expect(result.visitedNodes).toContain(end);
      for (const node of avoided) expect(result.visitedNodes).not.toContain(node);
    });
  });
});
