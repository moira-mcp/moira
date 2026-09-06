/**
 * Unit tests for validating workflows that contain custom (extension-contributed) nodes.
 *
 * The dangerous way to admit a custom type is to loosen the closed set of node branches in the
 * graph schema. That would keep every test about custom nodes green while silently switching off
 * body validation for the built-in types, so the built-in checks are asserted here alongside the
 * new ones — with the same broken bodies that had to fail before this change.
 */

import { describe, test, expect, beforeEach } from "@jest/globals";
import {
  GraphValidator,
  ExtensionRegistry,
  EXTENSION_API_VERSION,
} from "@mcp-moira/workflow-engine";
import type { ExtensionManifest, WorkflowGraph } from "@mcp-moira/workflow-engine";

const MANIFEST: ExtensionManifest = {
  apiVersion: EXTENSION_API_VERSION,
  name: "corporate-messenger",
  version: "1.0.0",
  entrypoint: "dist/index.js",
  nodes: [
    {
      type: "corporate-messenger.send",
      title: "Send message",
      configSchema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        required: ["messageId"],
        properties: { messageId: { type: "string" } },
      },
    },
  ],
};

function workflowWith(nodes: unknown[]): WorkflowGraph {
  return {
    metadata: { name: "Extension test", version: "1.0.0", description: "test" },
    nodes: nodes as WorkflowGraph["nodes"],
  };
}

function graphWithCustomNode(config: Record<string, unknown> = { text: "hello" }) {
  return workflowWith([
    { type: "start", id: "start", connections: { default: "send" } },
    {
      type: "corporate-messenger.send",
      id: "send",
      config,
      connections: { success: "end", error: "end" },
    },
    { type: "end", id: "end" },
  ]);
}

describe("Validation of extension nodes", () => {
  let registry: ExtensionRegistry;

  beforeEach(() => {
    registry = new ExtensionRegistry();
    registry.register(MANIFEST);
  });

  test("a workflow using a registered custom type is valid", async () => {
    const validator = new GraphValidator(undefined, { extensionRegistry: registry });

    const result = await validator.validateUnified(graphWithCustomNode());

    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("a custom node whose config violates the declared schema is rejected", async () => {
    const validator = new GraphValidator(undefined, { extensionRegistry: registry });

    const result = await validator.validateUnified(graphWithCustomNode({ text: "" }));

    const errors = result.issues.filter((issue) => issue.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("corporate-messenger.send");
    expect(result.valid).toBe(false);
  });

  test("a long-lived validator uses the schema from an in-place registry refresh", async () => {
    const validator = new GraphValidator(undefined, { extensionRegistry: registry });
    expect((await validator.validateUnified(graphWithCustomNode())).valid).toBe(true);

    registry.replaceAll([
      {
        ...MANIFEST,
        version: "2.0.0",
        nodes: [
          {
            ...MANIFEST.nodes[0],
            configSchema: {
              type: "object",
              required: ["text"],
              properties: { text: { type: "string", enum: ["different"] } },
            },
          },
        ],
      },
    ]);

    expect((await validator.validateUnified(graphWithCustomNode())).valid).toBe(false);
  });

  test("an unknown extension is an error that names the extension, not the node type alone", async () => {
    const emptyRegistry = new ExtensionRegistry();
    const validator = new GraphValidator(undefined, { extensionRegistry: emptyRegistry });

    const result = await validator.validateUnified(graphWithCustomNode());

    const errors = result.issues.filter((issue) => issue.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("corporate-messenger");
    expect(errors[0].message).toMatch(/not currently installed/);
  });

  test("without a registry a custom type is unresolvable, which is a warning and not an error", async () => {
    // This is the CLI's situation: it runs outside the container and cannot ask the registry.
    // Reporting an error there would make a valid workflow look broken.
    const validator = new GraphValidator();

    const result = await validator.validateUnified(graphWithCustomNode());

    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.valid).toBe(true);
    const warnings = result.issues.filter((issue) => issue.severity === "warning");
    expect(warnings.some((issue) => /cannot be resolved here/.test(issue.message))).toBe(true);
  });

  test("a custom node without a success connection is rejected", async () => {
    const validator = new GraphValidator(undefined, { extensionRegistry: registry });

    const result = await validator.validateUnified(
      workflowWith([
        { type: "start", id: "start", connections: { default: "send" } },
        { type: "corporate-messenger.send", id: "send", config: { text: "hi" }, connections: {} },
        { type: "end", id: "end" },
      ]),
    );

    expect(result.valid).toBe(false);
  });

  test("a type that is neither built-in nor namespaced is still an unknown type", async () => {
    const validator = new GraphValidator(undefined, { extensionRegistry: registry });

    const result = await validator.validateUnified(
      workflowWith([
        { type: "start", id: "start", connections: { default: "x" } },
        { type: "telegram_notification", id: "x", connections: { default: "end" } },
        { type: "end", id: "end" },
      ]),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => /Unknown node type/.test(issue.message))).toBe(true);
  });
});

describe("Built-in node validation is unchanged by admitting custom types", () => {
  // Each case below fails on the built-in branch of the graph schema. If admitting custom types
  // were implemented by relaxing that closed set, these bodies would start passing while every
  // test above stayed green.
  const registry = new ExtensionRegistry();
  registry.register(MANIFEST);

  test.each([
    [
      "telegram-notification without its required message",
      [
        { type: "start", id: "start", connections: { default: "t" } },
        { type: "telegram-notification", id: "t", connections: { default: "end" } },
        { type: "end", id: "end" },
      ],
    ],
    [
      "agent-directive with a non-string directive",
      [
        { type: "start", id: "start", connections: { default: "a" } },
        {
          type: "agent-directive",
          id: "a",
          directive: 42,
          completionCondition: "done",
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    ],
    [
      "expression node with an unexpected extra property",
      [
        { type: "start", id: "start", connections: { default: "e" } },
        {
          type: "expression",
          id: "e",
          expressions: ["a = 1 + 1"],
          unexpectedProperty: true,
          connections: { default: "end" },
        },
        { type: "end", id: "end" },
      ],
    ],
  ])("rejects %s", async (_name, nodes) => {
    const validator = new GraphValidator(undefined, { extensionRegistry: registry });

    const result = await validator.validateUnified(workflowWith(nodes));

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.severity === "error")).toBe(true);
  });
});
