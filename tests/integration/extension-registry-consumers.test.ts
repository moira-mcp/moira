/**
 * The same workflow through the consumers that live outside the engine's own tests.
 *
 * The engine's unit tests show that a validator resolves custom types once the process default is
 * set. What they cannot show is whether the consumers actually reach that default: the MCP tool
 * builds its own validators, and the CLI runs in a different process entirely and can only read the
 * published snapshot. Both are exercised here on one and the same graph.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { manageWorkflow } from "../../packages/mcp-server/src/tools/manage-workflow.js";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import {
  ExtensionRegistry,
  EXTENSION_API_VERSION,
  setActiveExtensionRegistry,
  writeExtensionRegistrySnapshot,
} from "@mcp-moira/workflow-engine";
import type { ExtensionManifest, WorkflowGraph } from "@mcp-moira/workflow-engine";

const TEST_USER_ID = "test-extension-registry-consumers";

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

const workflowWithCustomNode: WorkflowGraph = {
  metadata: {
    name: "Consumers",
    version: "1.0.0",
    description: "Workflow using a custom node type",
  },
  nodes: [
    { type: "start", id: "start", connections: { default: "send" } },
    {
      type: "corporate-messenger.send",
      id: "send",
      config: { text: "hello" },
      connections: { success: "end" },
    },
    { type: "end", id: "end" },
  ] as WorkflowGraph["nodes"],
};

function registryWithExtension(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.register(MANIFEST);
  return registry;
}

async function validateThroughMcp(): Promise<string> {
  const response = await runWithMCPContext({ userId: TEST_USER_ID }, () =>
    manageWorkflow({ action: "validate", workflow: workflowWithCustomNode as never }),
  );
  return JSON.stringify(response);
}

describe("MCP manage tool and the process registry", () => {
  afterAll(() => {
    setActiveExtensionRegistry(null);
  });

  test("the same workflow is unresolved without a registry and valid with one", async () => {
    // Both assertions look for text that appears in exactly one of the two states. The extension
    // name alone would not do: it is part of the node type and is present either way.
    setActiveExtensionRegistry(null);
    const without = await validateThroughMcp();
    expect(without).toMatch(/cannot be resolved here/);

    setActiveExtensionRegistry(registryWithExtension());
    const withRegistry = await validateThroughMcp();
    expect(withRegistry).not.toMatch(/cannot be resolved here/);
    expect(withRegistry).not.toMatch(/not currently installed/);
  });
});

describe("The CLI in a separate process", () => {
  let stateDir: string;
  let workflowFile: string;

  beforeAll(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-cli-registry-"));
    workflowFile = path.join(stateDir, "workflow.json");
    fs.writeFileSync(
      workflowFile,
      JSON.stringify({ ...workflowWithCustomNode, id: "cli-consumer-test" }, null, 2),
      "utf-8",
    );
  });

  afterAll(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function runCli(): { status: number; output: string } {
    try {
      const output = execFileSync(
        process.execPath,
        ["packages/workflow-cli/bin/moira-workflow.js", workflowFile, "validate"],
        {
          cwd: path.resolve(process.cwd()),
          // The CLI derives the state directory from the database path, exactly as the server does.
          env: { ...process.env, DB_PATH: path.join(stateDir, "moira.db") },
          encoding: "utf-8",
        },
      );
      return { status: 0, output };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? 1,
        output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      };
    }
  }

  test("without a snapshot the custom type is unresolved, not invalid", () => {
    const { output } = runCli();

    expect(output).toMatch(/cannot be resolved here/);
    expect(output).not.toMatch(/not currently installed/);
  });

  test("with a published snapshot the same workflow validates cleanly", () => {
    writeExtensionRegistrySnapshot(registryWithExtension(), stateDir);

    const { output } = runCli();

    expect(output).toMatch(/Workflow is valid/);
    expect(output).not.toMatch(/cannot be resolved here/);
  });
});
