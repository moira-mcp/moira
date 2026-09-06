/**
 * The backend's visualization check and the engine must agree about which node types exist.
 *
 * This check used to keep its own list of types, and the list silently fell behind: `materialize`
 * shipped and kept being reported as unsupported. The tests below fix both halves of the contract —
 * a built-in type is never called unsupported, and a custom type is judged by the registry rather
 * than by a copy of anything.
 */

import { describe, test, expect, afterEach } from "@jest/globals";
import { WorkflowValidationService } from "../../../packages/web-backend/src/services/validation-service.js";
import {
  ExtensionRegistry,
  EXTENSION_API_VERSION,
  setActiveExtensionRegistry,
  BUILTIN_NODE_TYPES,
} from "@mcp-moira/workflow-engine";
import type { ExtensionManifest } from "@mcp-moira/workflow-engine";

const MANIFEST: ExtensionManifest = {
  apiVersion: EXTENSION_API_VERSION,
  name: "corporate-messenger",
  version: "1.0.0",
  entrypoint: "dist/index.js",
  nodes: [
    {
      type: "corporate-messenger.send",
      title: "Send",
      configSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  ],
};

async function visualizationIssues(nodes: unknown[]): Promise<string[]> {
  const service = new WorkflowValidationService();
  // The visualization compatibility check is what owns the node-type question here; full schema
  // validation is covered by the engine's own tests.
  const result = await service.checkVisualizationCompatibility({
    metadata: { name: "T", version: "1.0.0", description: "d" },
    nodes,
  } as never);
  return result.issues;
}

describe("Backend node-type awareness", () => {
  afterEach(() => {
    setActiveExtensionRegistry(null);
  });

  test("no built-in type is reported as unsupported", async () => {
    const nodes = [
      { type: "start", id: "start", connections: { default: "end" } },
      ...BUILTIN_NODE_TYPES.filter((type) => type !== "start" && type !== "end").map((type) => ({
        type,
        id: `node-${type}`,
        connections: {},
      })),
      { type: "end", id: "end" },
    ];

    const issues = await visualizationIssues(nodes);

    expect(issues.filter((issue) => /Unsupported node type/.test(issue))).toEqual([]);
  });

  test("a genuinely unknown type is still reported", async () => {
    const issues = await visualizationIssues([
      { type: "start", id: "start", connections: { default: "x" } },
      { type: "telegram_notification", id: "x", connections: { default: "end" } },
      { type: "end", id: "end" },
    ]);

    expect(issues.some((issue) => /Unsupported node type/.test(issue))).toBe(true);
  });

  test("without a registry the custom type is a warning, matching what the validator says", async () => {
    // The disagreement this closes: the engine validator called the same workflow valid with a
    // warning, while this check called it invalid — and both answers travelled in one API response.
    const custom = [
      { type: "start", id: "start", connections: { default: "send" } },
      { type: "corporate-messenger.send", id: "send", connections: { success: "end" } },
      { type: "end", id: "end" },
    ];

    const service = new WorkflowValidationService();
    const result = await service.checkVisualizationCompatibility({
      metadata: { name: "T", version: "1.0.0", description: "d" },
      nodes: custom,
    } as never);

    expect(result.issues.filter((issue) => /node type/i.test(issue))).toEqual([]);
    expect(result.warnings.some((warning) => /cannot be resolved here/.test(warning))).toBe(true);
    expect(result.isCompatible).toBe(true);
  });

  test("a custom type is accepted when its extension is installed and named when it is not", async () => {
    const custom = [
      { type: "start", id: "start", connections: { default: "send" } },
      { type: "corporate-messenger.send", id: "send", connections: { success: "end" } },
      { type: "end", id: "end" },
    ];

    // "Not installed" is only sayable when a live registry is present and lacks the type.
    setActiveExtensionRegistry(new ExtensionRegistry());
    const withEmptyRegistry = await visualizationIssues(custom);
    expect(withEmptyRegistry.some((issue) => /not currently installed/.test(issue))).toBe(true);
    expect(withEmptyRegistry.some((issue) => /corporate-messenger/.test(issue))).toBe(true);

    const registry = new ExtensionRegistry();
    registry.register(MANIFEST);
    setActiveExtensionRegistry(registry);

    const withExtension = await visualizationIssues(custom);
    expect(withExtension.filter((issue) => /node type/i.test(issue))).toEqual([]);
  });
});
