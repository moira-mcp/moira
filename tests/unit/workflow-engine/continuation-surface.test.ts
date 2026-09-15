import { describe, expect, test } from "@jest/globals";
import {
  continuationSurfaceDigest,
  workflowGraphDigest,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

/**
 * The continuation surface decides whether a paused run may still continue against an updated
 * definition. These cases are the compatibility matrix: what must keep a run continuable, and what
 * must invalidate it. `paused` is the node the run sits on; `other` is a node it is not on.
 */
function graph(): WorkflowGraph {
  return {
    id: "continuation-surface-workflow",
    metadata: {
      name: "Continuation surface",
      version: "1.0.0",
      description: "Original description",
      tags: ["original"],
    },
    systemReminder: "Original reminder",
    variableRegistry: {
      target: { type: "string", description: "Where the work lands" },
      unrelated: { type: "string", description: "Never referenced by the paused node" },
    },
    nodes: [
      { type: "start", id: "start", connections: { default: "paused" } },
      {
        type: "agent-directive",
        id: "paused",
        directive: "Do the work",
        completionCondition: "The work is done",
        inputSchema: {
          type: "object",
          properties: { summary: { type: "string" } },
          globalInputs: ["target"],
        },
        connections: { success: "other" },
        connectionLabels: { success: "when the work is done" },
        progressNodeId: "block-work",
        progressActiveLabel: "Doing the work",
        progressActiveContent: { summary: "In progress" },
        metadata: { displayName: "Do the work", description: "A step", color: "#112233" },
      },
      {
        type: "agent-directive",
        id: "other",
        directive: "Do the later work",
        completionCondition: "The later work is done",
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

function withNode(change: (node: Record<string, unknown>) => void, id = "paused"): WorkflowGraph {
  const next = structuredClone(graph());
  const node = next.nodes.find((candidate) => candidate.id === id)! as unknown as Record<
    string,
    unknown
  >;
  change(node);
  return next;
}

const original = () => continuationSurfaceDigest(graph(), "paused");

describe("continuation surface of a paused node", () => {
  test.each([
    [
      "a version bump",
      (): WorkflowGraph => {
        const next = structuredClone(graph());
        next.metadata.version = "9.4.0";
        return next;
      },
    ],
    [
      "a tags-only edit",
      (): WorkflowGraph => {
        const next = structuredClone(graph());
        next.metadata.tags = ["reorganised"];
        return next;
      },
    ],
    [
      "a description edit",
      (): WorkflowGraph => {
        const next = structuredClone(graph());
        next.metadata.description = "Rewritten description";
        return next;
      },
    ],
    [
      "a system reminder edit",
      (): WorkflowGraph => {
        const next = structuredClone(graph());
        next.systemReminder = "Rewritten reminder";
        return next;
      },
    ],
    [
      "a change confined to another node",
      (): WorkflowGraph => withNode((node) => (node.directive = "Rewritten"), "other"),
    ],
    [
      "a registry entry the paused node does not declare",
      (): WorkflowGraph => {
        const next = structuredClone(graph());
        next.variableRegistry!.unrelated = { type: "number", description: "Retyped" };
        return next;
      },
    ],
    [
      "a display name on the paused node itself",
      (): WorkflowGraph =>
        withNode(
          (node) =>
            ((node.metadata as Record<string, unknown>).displayName = "Renamed for the diagram"),
        ),
    ],
    [
      "a colour on the paused node itself",
      (): WorkflowGraph =>
        withNode((node) => ((node.metadata as Record<string, unknown>).color = "#445566")),
    ],
    [
      "an authoring description on the paused node itself",
      (): WorkflowGraph =>
        withNode(
          (node) =>
            ((node.metadata as Record<string, unknown>).description = "Rewritten for humans"),
        ),
    ],
    [
      "the progress block and label of the paused node itself",
      (): WorkflowGraph =>
        withNode((node) => {
          node.progressNodeId = "block-renamed";
          node.progressActiveLabel = "Still doing the work";
        }),
    ],
    [
      "the progress content of the paused node itself",
      (): WorkflowGraph =>
        withNode((node) => (node.progressActiveContent = { summary: "Rewritten summary" })),
    ],
    [
      "a connection label on the paused node itself",
      (): WorkflowGraph =>
        withNode((node) => (node.connectionLabels = { success: "relabelled for the diagram" })),
    ],
    [
      "a new node added elsewhere",
      (): WorkflowGraph => {
        const next = structuredClone(graph());
        next.nodes.push({
          type: "teleport",
          id: "escape",
          hint: "Escape route",
        } as unknown as (typeof next.nodes)[number]);
        return next;
      },
    ],
  ])("keeps the run continuable across %s", (_label, mutate) => {
    const changed = mutate();
    expect(workflowGraphDigest(changed)).not.toBe(workflowGraphDigest(graph()));
    expect(continuationSurfaceDigest(changed, "paused")).toBe(original());
  });

  test.each([
    ["the node's type", (): WorkflowGraph => withNode((node) => (node.type = "user-notification"))],
    ["its directive", (): WorkflowGraph => withNode((node) => (node.directive = "Do other work"))],
    [
      "its completion condition",
      (): WorkflowGraph => withNode((node) => (node.completionCondition = "Something else")),
    ],
    [
      "its input schema",
      (): WorkflowGraph =>
        withNode((node) => {
          (node.inputSchema as { properties: Record<string, unknown> }).properties.extra = {
            type: "string",
          };
        }),
    ],
    [
      "its declared global inputs",
      (): WorkflowGraph =>
        withNode((node) => {
          (node.inputSchema as { globalInputs: string[] }).globalInputs = ["target", "unrelated"];
        }),
    ],
    [
      "its outgoing connections",
      (): WorkflowGraph => withNode((node) => (node.connections = { success: "end" })),
    ],
    [
      "a registry entry it declares as a global input",
      (): WorkflowGraph => {
        const next = structuredClone(graph());
        next.variableRegistry!.target = {
          type: "string",
          description: "Where the work lands",
          enum: ["a", "b"],
        };
        return next;
      },
    ],
    [
      "the registry entry it declares disappearing",
      (): WorkflowGraph => {
        const next = structuredClone(graph());
        delete next.variableRegistry!.target;
        return next;
      },
    ],
  ])("invalidates the run when %s changes", (_label, mutate) => {
    expect(continuationSurfaceDigest(mutate(), "paused")).not.toBe(original());
  });

  test("invalidates the run when the paused node no longer exists", () => {
    const next = structuredClone(graph());
    next.nodes = next.nodes.filter((node) => node.id !== "paused");

    expect(continuationSurfaceDigest(next, "paused")).not.toBe(original());
  });

  test("gives two different missing nodes different surfaces, so a deletion cannot collide", () => {
    const next = structuredClone(graph());
    next.nodes = [];

    expect(continuationSurfaceDigest(next, "paused")).not.toBe(
      continuationSurfaceDigest(next, "other"),
    );
  });
});

/**
 * Every node type that can hold a presented step attempt, with the authored field that type
 * actually presents through. Five handlers pause deliberately; an extension node pauses on itself
 * when its call fails, and the engine turns any node's error into a pause on that node — so the
 * binding must cover a type it was never told about, and this table is what would fail if it did
 * not. A matrix built from `agent-directive` alone is green either way, which is how a binding that
 * ignored `materialize` and `lock` entirely once passed a full suite.
 */
const pausingNodes: Array<
  [string, Record<string, unknown>, (node: Record<string, unknown>) => void]
> = [
  [
    "a materialize node's file list",
    {
      type: "materialize",
      id: "paused",
      basePath: "./out",
      files: [{ path: "guide.md", from: "guides/guide.md" }],
      connections: { success: "other" },
    },
    (node) => (node.files = [{ path: "other.md", from: "guides/other.md" }]),
  ],
  [
    "a materialize node's base path",
    {
      type: "materialize",
      id: "paused",
      basePath: "./out",
      files: [{ path: "guide.md", from: "guides/guide.md" }],
      connections: { success: "other" },
    },
    (node) => (node.basePath = "./elsewhere"),
  ],
  [
    "a lock node's reason",
    {
      type: "lock",
      id: "paused",
      reason: "approve the deploy",
      connections: { unlocked: "other" },
    },
    (node) => (node.reason = "approve the wire transfer"),
  ],
  [
    "a teleport node's hint",
    {
      type: "teleport",
      id: "paused",
      directive: "Pick up here",
      completionCondition: "Picked up",
      hint: "use when the plan is wrong",
      connections: { success: "other" },
    },
    (node) => (node.hint = "use when the deploy failed"),
  ],
  [
    "a subgraph node's referenced graph",
    {
      type: "subgraph",
      id: "paused",
      graphId: "child-workflow",
      inputMapping: { goal: "goal" },
      outputMapping: { result: "result" },
      connections: { success: "other" },
    },
    (node) => (node.graphId = "a-different-child-workflow"),
  ],
  [
    "a subgraph node's input mapping",
    {
      type: "subgraph",
      id: "paused",
      graphId: "child-workflow",
      inputMapping: { goal: "goal" },
      outputMapping: { result: "result" },
      connections: { success: "other" },
    },
    (node) => (node.inputMapping = { goal: "somethingElse" }),
  ],
  [
    "an extension node's configuration",
    {
      type: "vendor.review",
      id: "paused",
      config: { reviewers: 2 },
      connections: { success: "other" },
    },
    (node) => (node.config = { reviewers: 5 }),
  ],
];

describe("continuation surface across every node type that can pause", () => {
  function graphPausedOn(node: Record<string, unknown>): WorkflowGraph {
    return {
      id: "pausing-type-workflow",
      metadata: { name: "Pausing type", version: "1.0.0", description: "Original" },
      nodes: [
        { type: "start", id: "start", connections: { default: "paused" } },
        node as unknown as WorkflowGraph["nodes"][number],
        {
          type: "agent-directive",
          id: "other",
          directive: "Later",
          completionCondition: "Later done",
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };
  }

  test.each(pausingNodes)("invalidates the run when %s changes", (_label, node, mutate) => {
    const before = continuationSurfaceDigest(graphPausedOn(structuredClone(node)), "paused");
    const changed = structuredClone(node);
    mutate(changed);

    expect(continuationSurfaceDigest(graphPausedOn(changed), "paused")).not.toBe(before);
  });

  test.each(pausingNodes)(
    "keeps the run continuable when only display fields change alongside %s",
    (_label, node) => {
      const before = continuationSurfaceDigest(graphPausedOn(structuredClone(node)), "paused");
      const decorated = structuredClone(node);
      decorated.metadata = { displayName: "Renamed", color: "#778899" };
      decorated.progressActiveLabel = "A label for the diagram";
      decorated.connectionLabels = { success: "relabelled" };

      expect(continuationSurfaceDigest(graphPausedOn(decorated), "paused")).toBe(before);
    },
  );
});
