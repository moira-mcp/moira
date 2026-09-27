/**
 * Structural authoring functions (`@mcp-moira/workflow-engine/authoring`): each test builds a
 * small definition, applies one operation and asserts the resulting definition — never which
 * helpers ran. The process contract is observed through `deriveProcess`, and the kebab-case id
 * rule through the real validator.
 */

import { describe, expect, test } from "@jest/globals";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { GraphValidator } from "@mcp-moira/workflow-engine";
import { deriveProcess } from "@mcp-moira/workflow-engine/process";
import { validateNodeConnections, type GraphNode } from "@mcp-moira/workflow-engine/types";
import {
  AuthoringError,
  addBlock,
  addNode,
  findNodeReferences,
  findProseMentions,
  incomingEdges,
  insertNodeOnEdge,
  PRIMARY_OUTPUTS,
  removeBlock,
  removeConnection,
  removeNode,
  readChoice,
  renameNode,
  setChoice,
  setConnection,
  type Choice,
} from "@mcp-moira/workflow-engine/authoring";
import { catalogGraph } from "../../helpers/catalog-graphs.js";

function graph(value: unknown): WorkflowGraph {
  return value as WorkflowGraph;
}

function node(workflow: WorkflowGraph, id: string): Record<string, unknown> {
  const found = workflow.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found as unknown as Record<string, unknown>;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AuthoringError ? error.code : `not-authoring: ${String(error)}`;
  }
  return undefined;
}

function directive(id: string, connections: Record<string, string>, extra: object = {}) {
  return {
    id,
    type: "agent-directive",
    directive: `Do ${id}`,
    completionCondition: `${id} done`,
    connections,
    ...extra,
  };
}

/** A definition that references node `ask` in every form a reference can take. */
function everyReferenceKind(): WorkflowGraph {
  return graph({
    metadata: { name: "Refs", version: "1.0.0", description: "Every reference kind" },
    variableRegistry: {
      total: { type: "number", description: "Total", default: 0 },
      note: { type: "string", description: "Note", default: "Asked: {{ask.answer}}" },
    },
    runtimePolicy: { externalVariableWrites: { total: { allowedNodeIds: ["ask", "route"] } } },
    progress: {
      title: "About {{ask.answer}}",
      nodes: [
        {
          id: "work",
          label: "Work",
          content: { summary: "Answer was {{ask.answer}}" },
          list: { items: "ask.items", title: "name", current: "ask.index" },
        },
      ],
    },
    nodes: [
      { id: "start", type: "start", progressNodeId: "work", connections: { default: "ask" } },
      directive(
        "ask",
        { success: "route" },
        {
          progressNodeId: "work",
          inputSchema: {
            type: "object",
            properties: { answer: { type: "string" }, items: { type: "array" } },
          },
        },
      ),
      {
        id: "route",
        type: "condition",
        progressNodeId: "work",
        expressions: ["total = ask.count + 1", "label = 'ask.count stays'"],
        cases: [
          {
            when: {
              operator: "and",
              conditions: [
                { operator: "eq", left: { contextPath: "ask.answer" }, right: "yes" },
                { operator: "exists", value: { contextPath: "ask.items[0]" } },
              ],
            },
            output: "ask",
          },
        ],
        connections: { default: "notify", ask: "ask" },
        connectionLabels: { ask: { label: "ask again", cycle: { cause: "yes", exit: "no" } } },
      },
      {
        id: "notify",
        type: "user-notification",
        progressNodeId: "work",
        message: "Result {{ask.answer}}{{#if ask.answer}}!{{/if}} — the ask step said {{ask}}.",
        connections: { default: "confirm" },
      },
      {
        id: "confirm",
        type: "agent-directive",
        progressNodeId: "work",
        directive: "Confirm the answer {{ask.answer}} with the user.",
        completionCondition: "The user confirmed {{ask.answer}}.",
        progressActiveContent: { summary: "Confirming {{ask.answer}}" },
        connections: { success: "save" },
      },
      {
        id: "save",
        type: "write-note",
        progressNodeId: "work",
        batchMode: true,
        source: "ask.items",
        connections: { default: "sub" },
      },
      {
        id: "sub",
        type: "subgraph",
        progressNodeId: "work",
        graphId: "moira/other",
        inputMapping: { "ask.answer": "question" },
        outputMapping: { result: "ask.result" },
        connections: { success: "end" },
      },
      { id: "end", type: "end", progressNodeId: "work", finalOutput: ["ask.answer", "total"] },
    ],
  });
}

describe("renameNode", () => {
  const renamed = renameNode(everyReferenceKind(), "ask", "clarify");
  const next = renamed.workflow;

  test("renames the node and retargets every connection that led to it", () => {
    expect(next.nodes.some((n) => n.id === "ask")).toBe(false);
    expect(node(next, "clarify").type).toBe("agent-directive");
    expect((node(next, "start").connections as Record<string, string>).default).toBe("clarify");
    expect((node(next, "route").connections as Record<string, string>).ask).toBe("clarify");
  });

  test("rewrites template references and block-helper arguments, not bare mentions", () => {
    expect(node(next, "notify").message).toBe(
      "Result {{clarify.answer}}{{#if clarify.answer}}!{{/if}} — the ask step said {{ask}}.",
    );
    expect(node(next, "confirm").directive).toBe(
      "Confirm the answer {{clarify.answer}} with the user.",
    );
    expect(node(next, "confirm").completionCondition).toBe(
      "The user confirmed {{clarify.answer}}.",
    );
    expect(node(next, "confirm").progressActiveContent).toEqual({
      summary: "Confirming {{clarify.answer}}",
    });
    expect(next.variableRegistry?.note.default).toBe("Asked: {{clarify.answer}}");
    expect(next.progress?.title).toBe("About {{clarify.answer}}");
    expect(next.progress?.nodes[0].content?.summary).toBe("Answer was {{clarify.answer}}");
  });

  test("rewrites condition paths, list bindings, mappings, final output and batch sources", () => {
    const cases = node(next, "route").cases as Array<{ when: { conditions: unknown[] } }>;
    expect(cases[0].when.conditions).toEqual([
      { operator: "eq", left: { contextPath: "clarify.answer" }, right: "yes" },
      { operator: "exists", value: { contextPath: "clarify.items[0]" } },
    ]);
    expect(next.progress?.nodes[0].list).toEqual({
      items: "clarify.items",
      title: "name",
      current: "clarify.index",
    });
    expect(node(next, "sub").inputMapping).toEqual({ "clarify.answer": "question" });
    expect(node(next, "sub").outputMapping).toEqual({ result: "clarify.result" });
    expect(node(next, "end").finalOutput).toEqual(["clarify.answer", "total"]);
    expect(node(next, "save").source).toBe("clarify.items");
  });

  test("rewrites expression identifiers but not the text inside string literals", () => {
    expect(node(next, "route").expressions).toEqual([
      "total = clarify.count + 1",
      "label = 'ask.count stays'",
    ]);
  });

  test("renames write allowances and leaves connection keys and case outputs alone", () => {
    expect(next.runtimePolicy?.externalVariableWrites?.total.allowedNodeIds).toEqual([
      "clarify",
      "route",
    ]);
    const route = node(next, "route");
    expect(Object.keys(route.connections as object)).toEqual(["default", "ask"]);
    expect((route.cases as Array<{ output: string }>)[0].output).toBe("ask");
    expect(Object.keys(route.connectionLabels as object)).toEqual(["ask"]);
  });

  test("reports every rewritten location with its count", () => {
    const byPath = Object.fromEntries(renamed.rewritten.map((r) => [r.path, r.count]));
    expect(byPath["nodes[notify].message"]).toBe(2);
    expect(byPath["nodes[start].connections"]).toBe(1);
    expect(byPath["nodes[route].connections"]).toBe(1);
    expect(byPath["nodes[route].expressions[0]"]).toBe(1);
    expect(byPath["nodes[route].expressions[1]"]).toBeUndefined();
    expect(byPath["runtimePolicy.externalVariableWrites.total.allowedNodeIds"]).toBe(1);
  });

  test("leaves the original definition untouched", () => {
    const original = everyReferenceKind();
    renameNode(original, "ask", "clarify");
    expect(original).toEqual(everyReferenceKind());
  });

  test.each([
    ["an existing id", "route", "node-exists"],
    ["a dotted id", "ask.again", "invalid-node-id"],
    ["an upper-case id", "Ask", "invalid-node-id"],
  ])("refuses %s as the new id", (_case, to, code) => {
    expect(codeOf(() => renameNode(everyReferenceKind(), "ask", to))).toBe(code);
  });
});

test("locations inside the renamed node are reported under its new id", () => {
  const selfReferencing = graph({
    metadata: { name: "Self", version: "1.0.0", description: "Self" },
    nodes: [
      { id: "start", type: "start", connections: { default: "x" } },
      directive("x", { success: "end" }, { directive: "Keep {{x.value}}" }),
      { id: "end", type: "end" },
    ],
  });
  const paths = renameNode(selfReferencing, "x", "y").rewritten.map((r) => r.path);
  expect(paths).toContain("nodes[y].directive");
  expect(paths.some((path) => path.startsWith("nodes[x]"))).toBe(false);
});

describe("reference and prose lookup", () => {
  test("finds the references to a node without changing anything", () => {
    const paths = findNodeReferences(everyReferenceKind(), "ask").map((r) => r.path);
    expect(paths).toContain("nodes[notify].message");
    expect(paths).toContain("variableRegistry.note.default");
    expect(paths).toContain("nodes[sub].inputMapping");
  });

  test("finds prose that mentions the id outside a reference", () => {
    const prose = findProseMentions(everyReferenceKind(), "ask");
    expect(prose).toEqual(expect.arrayContaining([{ path: "nodes[notify].message", count: 2 }]));
    expect(prose.map((p) => p.path)).not.toContain("nodes[route].cases");
  });

  test("finds prose outside the nodes too, and never a reference there", () => {
    const workflow = everyReferenceKind();
    workflow.metadata.description = "Starts with ask";
    workflow.variableRegistry!.note.description = "Set by ask";
    workflow.progress!.goal = "Whatever ask decides";
    const block = workflow.progress!.nodes[0];
    block.content = { summary: "Runs after ask approves: {{ask.answer}}" };
    workflow.systemReminder = "Never skip ask.";
    // An item path that happens to spell the id is still a path, not prose.
    block.list = { ...block.list!, title: "ask.label" };
    const prose = findProseMentions(workflow, "ask");
    expect(prose).toEqual(
      expect.arrayContaining([
        { path: "metadata.description", count: 1 },
        { path: "variableRegistry.note.description", count: 1 },
        { path: "progress.goal", count: 1 },
        // One word mention; the template beside it is a reference the rename rewrites.
        { path: "progress.nodes[0].content.summary", count: 1 },
        { path: "systemReminder", count: 1 },
      ]),
    );
    const paths = prose.map((p) => p.path);
    expect(paths).not.toContain("progress.title");
    expect(paths).not.toContain("variableRegistry.note.default");
    // A list binding holds paths only, the title included (it is read inside one item).
    expect(paths.some((path) => path.startsWith("progress.nodes[0].list"))).toBe(false);
  });
});

/** Two blocks: `plan` (start, p) and `do` (d, end); p → d crosses and carries a label. */
function twoBlocks(): WorkflowGraph {
  return graph({
    metadata: { name: "Two", version: "1.0.0", description: "Two blocks" },
    progress: {
      nodes: [
        { id: "plan", label: "Plan", content: { summary: "Plan it" } },
        { id: "do", label: "Do", content: { summary: "Do it" } },
      ],
    },
    nodes: [
      { id: "start", type: "start", progressNodeId: "plan", connections: { default: "p" } },
      directive(
        "p",
        { success: "d" },
        { progressNodeId: "plan", connectionLabels: { success: "go" } },
      ),
      directive("d", { success: "end", retry: "end" }, { progressNodeId: "do" }),
      { id: "end", type: "end", progressNodeId: "do" },
    ],
  });
}

const newStep = (id: string) => directive(id, {}) as unknown as GraphNode;

describe("insertNodeOnEdge", () => {
  test("a step inserted in the source's block takes over the crossing edge's label", () => {
    const next = insertNodeOnEdge(twoBlocks(), { source: "p", key: "success" }, newStep("x"));
    expect(node(next, "p").connections).toEqual({ success: "x" });
    expect(node(next, "x").connections).toEqual({ success: "d" });
    expect(node(next, "x").progressNodeId).toBe("plan");
    expect(node(next, "x").connectionLabels).toEqual({ success: "go" });
    expect(node(next, "p").connectionLabels).toBeUndefined();
    expect(deriveProcess(next)?.diagnostics).toEqual([]);
  });

  test("a step inserted in the target's block leaves the label on the source edge", () => {
    const next = insertNodeOnEdge(twoBlocks(), { source: "p", key: "success" }, newStep("x"), {
      blockId: "do",
    });
    expect(node(next, "p").connectionLabels).toEqual({ success: "go" });
    expect(node(next, "x").connectionLabels).toBeUndefined();
    expect(deriveProcess(next)?.diagnostics).toEqual([]);
  });

  test("on a flow without a process view a step is inserted without a block, and a block is refused", () => {
    const plain = graph({ ...twoBlocks(), progress: undefined });
    const next = insertNodeOnEdge(plain, { source: "p", key: "success" }, newStep("x"));
    expect(node(next, "x").progressNodeId).toBeUndefined();
    expect(node(next, "p").connections).toEqual({ success: "x" });
    expect(
      codeOf(() =>
        insertNodeOnEdge(plain, { source: "p", key: "success" }, newStep("x"), { blockId: "do" }),
      ),
    ).toBe("no-progress");
  });

  test("an end node cannot be inserted, because it cannot continue", () => {
    const end = { id: "stop", type: "end" } as unknown as GraphNode;
    expect(codeOf(() => insertNodeOnEdge(twoBlocks(), { source: "p", key: "success" }, end))).toBe(
      "terminal-node",
    );
  });
});

describe("reconnecting and the process contract", () => {
  test("turning a forward edge into a return is reported as an unexplained cycle on that edge", () => {
    const before = deriveProcess(twoBlocks())?.diagnostics ?? [];
    expect(before).toEqual([]);
    const next = setConnection(twoBlocks(), "d", "retry", "p");
    const diagnostics = deriveProcess(next)?.diagnostics ?? [];
    expect(diagnostics.filter((d) => d.edge === "d.retry").map((d) => d.code)).toEqual([
      "unlabeled-edge",
      "unexplained-cycle",
    ]);
  });

  test("removing a cycle clears the diagnostic of another edge the walk classified as a return", () => {
    // One block; the walk start → a → b → c meets b again through c.success, a back-edge.
    const cyclic = graph({
      metadata: { name: "Cycle", version: "1.0.0", description: "Cycle" },
      progress: { nodes: [{ id: "work", label: "Work", content: { summary: "Work" } }] },
      nodes: [
        { id: "start", type: "start", progressNodeId: "work", connections: { default: "a" } },
        directive("a", { success: "b", other: "c" }, { progressNodeId: "work" }),
        directive("b", { success: "c" }, { progressNodeId: "work" }),
        directive("c", { success: "b", done: "end" }, { progressNodeId: "work" }),
        { id: "end", type: "end", progressNodeId: "work" },
      ],
    });
    const before = deriveProcess(cyclic)?.diagnostics ?? [];
    expect(before.some((d) => d.edge === "c.success")).toBe(true);
    const next = setConnection(cyclic, "b", "success", "end");
    const after = deriveProcess(next)?.diagnostics ?? [];
    expect(after.some((d) => d.edge === "c.success")).toBe(false);
  });

  test("refuses a connection key with a dot and a target that does not exist", () => {
    expect(codeOf(() => setConnection(twoBlocks(), "d", "a.b", "end"))).toBe(
      "invalid-connection-key",
    );
    expect(codeOf(() => setConnection(twoBlocks(), "d", "retry", "nowhere"))).toBe(
      "node-not-found",
    );
  });

  test("the primary output cannot be removed; another output and its label go together", () => {
    expect(codeOf(() => removeConnection(twoBlocks(), "d", "success"))).toBe("protected-output");
    const labelled = graph({
      ...twoBlocks(),
      nodes: twoBlocks().nodes.map((n) =>
        n.id === "d" ? { ...n, connectionLabels: { retry: "again" } } : n,
      ),
    });
    const next = removeConnection(labelled, "d", "retry");
    expect(node(next, "d").connections).toEqual({ success: "end" });
    expect(node(next, "d").connectionLabels).toBeUndefined();
  });
});

describe("removeNode", () => {
  test("refuses while an incoming edge has no decision, naming the edge", () => {
    let message = "";
    try {
      removeNode(twoBlocks(), "d");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("p.success");
    expect(codeOf(() => removeNode(twoBlocks(), "d"))).toBe("incoming-edge-undecided");
  });

  test("retargets the incoming edges, so no connection is left dangling", () => {
    const next = removeNode(twoBlocks(), "d", { "p.success": "end" });
    expect(next.nodes.map((n) => n.id)).toEqual(["start", "p", "end"]);
    expect(incomingEdges(next, "d")).toEqual([]);
    expect(node(next, "p").connections).toEqual({ success: "end" });
  });

  test("dropping a primary output is refused; retargeting it is the way", () => {
    expect(codeOf(() => removeNode(twoBlocks(), "d", { "p.success": null }))).toBe(
      "protected-output",
    );
  });

  test("removes the node from write allowances", () => {
    const next = removeNode(everyReferenceKind(), "ask", {
      "start.default": "route",
      "route.ask": "notify",
    });
    expect(next.runtimePolicy?.externalVariableWrites?.total.allowedNodeIds).toEqual(["route"]);
  });

  test("the start node cannot be removed", () => {
    expect(codeOf(() => removeNode(twoBlocks(), "start"))).toBe("only-start");
  });
});

describe("addNode", () => {
  test("a new step of a process-annotated flow must name an existing block", () => {
    expect(codeOf(() => addNode(twoBlocks(), newStep("x")))).toBe("block-required");
    expect(codeOf(() => addNode(twoBlocks(), newStep("x"), { blockId: "nope" }))).toBe(
      "block-not-found",
    );
    const next = addNode(twoBlocks(), newStep("x"), { blockId: "do" });
    expect(node(next, "x").progressNodeId).toBe("do");
  });

  test("a flow without a process view takes a step without a block", () => {
    const plain = graph({ ...twoBlocks(), progress: undefined });
    const next = addNode(plain, newStep("x"));
    expect(node(next, "x").progressNodeId).toBeUndefined();
  });

  test("a second start node is refused", () => {
    const start = { id: "begin", type: "start", connections: { default: "p" } } as GraphNode;
    expect(codeOf(() => addNode(twoBlocks(), start, { blockId: "plan" }))).toBe("duplicate-start");
  });
});

describe("removeNode dropping an edge", () => {
  test("a dropped non-primary edge is removed together with its label", () => {
    const withSpare = setConnection(
      addNode(twoBlocks(), newStep("z"), { blockId: "do" }),
      "d",
      "retry",
      "z",
    );
    const labelled = graph({
      ...withSpare,
      nodes: withSpare.nodes.map((n) =>
        n.id === "d" ? { ...n, connectionLabels: { retry: "try the spare" } } : n,
      ),
    });
    const next = removeNode(labelled, "z", { "d.retry": null });
    expect(node(next, "d").connections).toEqual({ success: "end" });
    expect(node(next, "d").connectionLabels).toBeUndefined();
    expect(next.nodes.some((n) => n.id === "z")).toBe(false);
  });
});

describe("blocks", () => {
  test("a block that owns a node cannot be removed; an empty one can", () => {
    expect(codeOf(() => removeBlock(twoBlocks(), "do"))).toBe("block-not-empty");
    const withEmpty = addBlock(twoBlocks(), { id: "spare", label: "Spare", summary: "Unused" });
    const next = removeBlock(withEmpty, "spare");
    expect(next.progress?.nodes.map((b) => b.id)).toEqual(["plan", "do"]);
  });

  test("removing a block clears the block links that pointed at it", () => {
    const linked = addBlock(twoBlocks(), { id: "spare", label: "Spare", summary: "Unused" });
    linked.progress!.nodes[1] = { ...linked.progress!.nodes[1], connections: { default: "spare" } };
    const next = removeBlock(linked, "spare");
    expect(next.progress?.nodes[1]).not.toHaveProperty("connections");
    expect(next.progress?.nodes[0]).toEqual(twoBlocks().progress?.nodes[0]);
  });

  test("a block needs a unique id and a description", () => {
    expect(codeOf(() => addBlock(twoBlocks(), { id: "do", label: "Again", summary: "x" }))).toBe(
      "block-exists",
    );
    expect(codeOf(() => addBlock(twoBlocks(), { id: "new", label: "New", summary: " " }))).toBe(
      "invalid-block",
    );
  });
});

describe("primary outputs", () => {
  test.each(Object.entries(PRIMARY_OUTPUTS))(
    "the %s type's primary output is the connection validation requires",
    (type, primary) => {
      const bare = { id: "n", type, connections: {} } as unknown as GraphNode;
      const errors = validateNodeConnections(bare).errors.join(" ");
      if (primary === null) expect(errors).not.toMatch(/must have "/);
      else expect(errors).toContain(`"${primary}"`);
    },
  );
});

describe("kebab-case node ids in the schema", () => {
  test.each([["with.dot"], ["UpperCase"], ["_leading"]])(
    "validation refuses the node id %s",
    async (id) => {
      const workflow = graph({
        ...twoBlocks(),
        nodes: twoBlocks().nodes.map((n) => (n.id === "d" ? { ...n, id } : n)),
      });
      const result = await new GraphValidator().validateUnified(workflow);
      expect(result.valid).toBe(false);
      const idErrors = result.issues.filter(
        (i) => i.severity === "error" && /pattern/.test(i.message),
      );
      expect(idErrors.map((i) => i.nodeId)).toEqual([id]);
    },
  );

  test("a kebab-case definition passes the id rule", async () => {
    const result = await new GraphValidator().validateUnified(twoBlocks());
    expect(result.issues.filter((i) => /pattern/.test(i.message))).toEqual([]);
  });
});

describe("a step's choice", () => {
  /** Example 2 ("One choice") and the same flow with `check-result`'s choice taken out by hand. */
  const example = () => catalogGraph("example-one-choice");
  const withoutChoice = () => {
    const bare = example();
    const step = node(bare, "check-result") as {
      inputSchema: { properties: Record<string, unknown>; required: string[] };
      cases?: unknown;
      connections: Record<string, string>;
      connectionLabels?: Record<string, unknown>;
    };
    delete step.inputSchema.properties.matches;
    step.inputSchema.required = [];
    delete step.cases;
    delete step.connections.no;
    delete step.connectionLabels;
    return bare;
  };
  const exampleChoice = (): Choice => {
    const source = node(example(), "check-result") as {
      inputSchema: { properties: { matches: { description: string } } };
      connectionLabels: Record<string, string>;
    };
    return {
      field: "matches",
      question: source.inputSchema.properties.matches.description,
      options: ["yes", "no"],
      defaultOption: "yes",
      targets: { no: "explain-gap" },
      labels: { yes: source.connectionLabels.success, no: source.connectionLabels.no },
    };
  };

  test("setting it rebuilds the example's step exactly", () => {
    const built = setChoice(withoutChoice(), "check-result", exampleChoice());
    expect(node(built, "check-result")).toEqual(node(example(), "check-result"));
  });

  test("the example's step reads back as that choice", () => {
    expect(readChoice(node(example(), "check-result") as never)).toEqual(exampleChoice());
  });

  test("removing it takes the field, its cases and option outputs, and keeps success", () => {
    const removed = node(setChoice(example(), "check-result", null), "check-result");
    expect(removed.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    });
    expect(removed.cases).toBeUndefined();
    expect(removed.connections).toEqual({ success: "report" });
  });

  test("editing the options keeps one case per non-default option", () => {
    const edited = setChoice(example(), "check-result", {
      ...exampleChoice(),
      options: ["yes", "missing", "partly"],
      targets: { missing: "explain-gap", partly: "report" },
      labels: {},
    });
    const step = node(edited, "check-result") as {
      cases: Array<{ output: string; when: { right: string } }>;
      connections: Record<string, string>;
    };
    expect(step.cases.map((c) => [c.when.right, c.output])).toEqual([
      ["missing", "missing"],
      ["partly", "partly"],
    ]);
    expect(step.connections).toEqual({
      success: "report",
      missing: "explain-gap",
      partly: "report",
    });
    expect(readChoice(step as never)?.options).toEqual(["yes", "missing", "partly"]);
  });

  test("renaming the step keeps its choice readable", () => {
    const renamed = renameNode(example(), "check-result", "compare").workflow;
    expect(readChoice(node(renamed, "compare") as never)?.field).toBe("matches");
  });

  test.each([
    ["a non-agent step", "start", {}],
    [
      "a control output as an option",
      "check-result",
      { options: ["yes", "error"], targets: { error: "report" } },
    ],
    [
      "the primary output as an option",
      "check-result",
      { options: ["yes", "success"], targets: { success: "report" } },
    ],
    ["the same option twice", "check-result", { options: ["yes", "no", "no"] }],
    ["a single option", "check-result", { options: ["yes"], targets: {} }],
    ["an option with no step to lead to", "check-result", { targets: {} }],
    ["a default that is not an option", "check-result", { defaultOption: "maybe" }],
    ["an answer field that is not a name", "check-result", { field: "is matching" }],
  ])("refuses %s", (_name, nodeId, change) => {
    const code = codeOf(() =>
      setChoice(withoutChoice(), nodeId, { ...exampleChoice(), ...(change as Partial<Choice>) }),
    );
    expect(["invalid-choice", "invalid-target"]).toContain(code);
  });

  test("refuses an option that takes an output the step already uses", () => {
    const bare = setConnection(withoutChoice(), "check-result", "no", "report");
    expect(codeOf(() => setChoice(bare, "check-result", exampleChoice()))).toBe("invalid-choice");
  });

  test("refuses a step that routes in another way", () => {
    const other = withoutChoice();
    (node(other, "check-result") as { cases?: unknown }).cases = [
      { when: { operator: "exists", value: { contextPath: "check-result.x" } }, output: "success" },
    ];
    expect(codeOf(() => setChoice(other, "check-result", exampleChoice()))).toBe("invalid-choice");
  });
});
