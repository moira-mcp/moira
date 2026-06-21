/**
 * Node output-scope unit tests
 *
 * Covers the two pure functions behind the explicit output-scope model:
 *  - getNodeOutputScope: reads a node's declared global writes (inputSchema.globalInputs)
 *    and its local outputs (inputSchema.properties).
 *  - inlineGlobalInputs: transforms the stored node schema into the flat JSON Schema the
 *    agent actually receives — globalInputs names inlined as normal properties (type/description
 *    resolved from the variableRegistry), the non-standard `globalInputs` key removed.
 *
 * The agent must never see the global/local distinction: it gets one ordinary object schema.
 */

import { describe, test, expect } from "@jest/globals";
import {
  getNodeOutputScope,
  inlineGlobalInputs,
  type AgentDirectiveNode,
  type GraphNode,
} from "@mcp-moira/workflow-engine";
import { SchemaValidator } from "../../../packages/workflow-engine/src/utils/schema-validator.js";

function makeNode(inputSchema: unknown): AgentDirectiveNode {
  return {
    type: "agent-directive",
    id: "n1",
    directive: "do work",
    completionCondition: "done",
    inputSchema: inputSchema as AgentDirectiveNode["inputSchema"],
    connections: { success: "end" },
  };
}

describe("getNodeOutputScope", () => {
  test("separates declared globals from local properties", () => {
    const node = makeNode({
      type: "object",
      globalInputs: ["score", "feedback"],
      properties: { scratch: { type: "string" } },
      required: ["score", "feedback"],
    });

    const scope = getNodeOutputScope(node);

    expect([...scope.globalInputs].sort()).toEqual(["feedback", "score"]);
    expect([...scope.localOutputs]).toEqual(["scratch"]);
  });

  test("returns empty sets for a node without inputSchema", () => {
    const node: GraphNode = {
      type: "condition",
      id: "c1",
      condition: { operator: "exists", value: { contextPath: "x" } },
      connections: { true: "a", false: "b" },
    } as unknown as GraphNode;

    const scope = getNodeOutputScope(node);

    expect(scope.globalInputs.size).toBe(0);
    expect(scope.localOutputs.size).toBe(0);
  });

  test("ignores non-string entries in globalInputs", () => {
    const node = makeNode({
      type: "object",
      globalInputs: ["ok", 42, null],
      properties: {},
    });

    const scope = getNodeOutputScope(node);

    expect([...scope.globalInputs]).toEqual(["ok"]);
  });
});

describe("inlineGlobalInputs", () => {
  const registry = {
    score: { type: "number", description: "Validator score" },
    feedback: { type: "string", description: "Validator feedback" },
    gate: { type: "string", description: "Yes/no gate", enum: ["yes", "no"] },
    counter: { type: "number", description: "Counter", default: 0 },
    tags: { type: "array", description: "Tags", items: { type: "string", minLength: 1 } },
    metric: {
      type: "object",
      description: "Metric",
      properties: { name: { type: "string" }, target: { type: "number" } },
      required: ["name"],
    },
    path: { type: "string", description: "Path", pattern: "^\\./moira-ws/.+", minLength: 12 },
  };

  test("inlines global names as properties with type/description from the registry", () => {
    const node = makeNode({
      type: "object",
      globalInputs: ["score", "feedback"],
      properties: {},
      required: ["score", "feedback"],
    });

    const effective = inlineGlobalInputs(node, registry);
    const schema = (effective as AgentDirectiveNode).inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;

    // Agent sees one plain JSON Schema: globals appear as ordinary properties.
    expect(props.score).toEqual({ type: "number", description: "Validator score" });
    expect(props.feedback).toEqual({ type: "string", description: "Validator feedback" });
    // The non-standard scope key is stripped — the agent never sees it.
    expect("globalInputs" in schema).toBe(false);
    // required is preserved as stored.
    expect(schema.required).toEqual(["score", "feedback"]);
  });

  test("carries enum and default from the registry into the inlined global property", () => {
    const node = makeNode({
      type: "object",
      globalInputs: ["gate", "counter"],
      properties: {},
      required: ["gate"],
    });

    const effective = inlineGlobalInputs(node, registry);
    const props = ((effective as AgentDirectiveNode).inputSchema as Record<string, unknown>)
      .properties as Record<string, unknown>;

    // enum is carried so the agent's response is validated against the allowed values —
    // an enum-constrained gate (yes/no) must not accept free text.
    expect(props.gate).toEqual({ type: "string", description: "Yes/no gate", enum: ["yes", "no"] });
    // default is carried through as well.
    expect(props.counter).toEqual({ type: "number", description: "Counter", default: 0 });
  });

  test("an agent response outside a global's enum is rejected end-to-end", () => {
    // Full chain: a gate global with enum is inlined, then the agent's response is validated
    // against that inlined schema. A free-text confirmation must NOT pass the gate.
    const node = makeNode({
      type: "object",
      globalInputs: ["gate"],
      properties: {},
      required: ["gate"],
    });
    const schema = (inlineGlobalInputs(node, registry) as AgentDirectiveNode).inputSchema as Record<
      string,
      unknown
    >;

    const freeText = SchemaValidator.validate(
      { gate: "yes — confirmed, no changes needed" },
      schema,
    );
    expect(freeText.isValid).toBe(false);

    const allowed = SchemaValidator.validate({ gate: "yes" }, schema);
    expect(allowed.isValid).toBe(true);
  });

  test("carries the whole descriptor (items, properties, pattern) into the inlined property", () => {
    const node = makeNode({
      type: "object",
      globalInputs: ["tags", "metric", "path"],
      properties: {},
      required: ["tags", "metric", "path"],
    });
    const props = (
      (inlineGlobalInputs(node, registry) as AgentDirectiveNode).inputSchema as Record<
        string,
        unknown
      >
    ).properties as Record<string, Record<string, unknown>>;

    expect(props.tags.items).toEqual({ type: "string", minLength: 1 });
    expect(props.metric.properties).toEqual({
      name: { type: "string" },
      target: { type: "number" },
    });
    expect(props.metric.required).toEqual(["name"]);
    expect(props.path.pattern).toBe("^\\./moira-ws/.+");
    expect(props.path.minLength).toBe(12);
  });

  test("rejects an agent response violating items/pattern constraints end-to-end", () => {
    const node = makeNode({
      type: "object",
      globalInputs: ["tags", "path"],
      properties: {},
      required: ["tags", "path"],
    });
    const schema = (inlineGlobalInputs(node, registry) as AgentDirectiveNode).inputSchema as Record<
      string,
      unknown
    >;

    // Array element violates items.minLength; path violates pattern.
    const bad = SchemaValidator.validate({ tags: [""], path: "nope" }, schema);
    expect(bad.isValid).toBe(false);

    const good = SchemaValidator.validate(
      { tags: ["alpha"], path: "./moira-ws/feature-x" },
      schema,
    );
    expect(good.isValid).toBe(true);
  });

  test("merges globals alongside existing local properties without clobbering them", () => {
    const node = makeNode({
      type: "object",
      globalInputs: ["score"],
      properties: { note: { type: "string", description: "local note" } },
      required: ["score"],
    });

    const effective = inlineGlobalInputs(node, registry);
    const props = ((effective as AgentDirectiveNode).inputSchema as Record<string, unknown>)
      .properties as Record<string, unknown>;

    expect(props.note).toEqual({ type: "string", description: "local note" });
    expect(props.score).toEqual({ type: "number", description: "Validator score" });
  });

  test("falls back to a permissive object schema when a global is absent from the registry", () => {
    const node = makeNode({
      type: "object",
      globalInputs: ["unknownVar"],
      properties: {},
      required: ["unknownVar"],
    });

    const effective = inlineGlobalInputs(node, registry);
    const props = ((effective as AgentDirectiveNode).inputSchema as Record<string, unknown>)
      .properties as Record<string, unknown>;

    expect(props.unknownVar).toEqual({});
  });

  test("does not overwrite a local property that shares a name with a global", () => {
    const node = makeNode({
      type: "object",
      globalInputs: ["score"],
      properties: { score: { type: "string", description: "local wins" } },
    });

    const effective = inlineGlobalInputs(node, registry);
    const props = ((effective as AgentDirectiveNode).inputSchema as Record<string, unknown>)
      .properties as Record<string, unknown>;

    expect(props.score).toEqual({ type: "string", description: "local wins" });
  });

  test("returns the node unchanged when it has no globalInputs", () => {
    const node = makeNode({
      type: "object",
      properties: { local: { type: "string" } },
      required: ["local"],
    });

    const effective = inlineGlobalInputs(node, registry);

    expect(effective).toBe(node);
  });

  test("returns the node unchanged when globalInputs is an empty array", () => {
    const node = makeNode({ type: "object", globalInputs: [], properties: {} });

    const effective = inlineGlobalInputs(node, registry);

    expect(effective).toBe(node);
  });

  test("does not mutate the original node", () => {
    const node = makeNode({
      type: "object",
      globalInputs: ["score"],
      properties: {},
      required: ["score"],
    });

    inlineGlobalInputs(node, registry);

    const original = node.inputSchema as Record<string, unknown>;
    expect(original.globalInputs).toEqual(["score"]);
    expect(original.properties).toEqual({});
  });
});
