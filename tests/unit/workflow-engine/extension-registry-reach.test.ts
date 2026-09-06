/**
 * Whether every consumer of the node-type list agrees about the same workflow.
 *
 * The failure this guards against is not "validation is wrong" but "validation disagrees with
 * itself": a workflow accepted by the engine and rejected by the backend, the MCP tools or the
 * CLI. That disagreement is invisible from any single call site, so the same graph is put through
 * each of them here, including the one that cannot ask the registry at all.
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GraphValidator,
  ExtensionRegistry,
  EXTENSION_API_VERSION,
  setActiveExtensionRegistry,
  getActiveExtensionRegistry,
  readExtensionRegistrySnapshot,
  writeExtensionRegistrySnapshot,
  publishExtensionRegistry,
  initializeExtensionsForProcess,
  getActiveExtensionRunnerClient,
  setActiveExtensionRunnerClient,
  extensionRegistrySnapshotPath,
  BUILTIN_NODE_TYPES,
  isBuiltinNodeType,
} from "@mcp-moira/workflow-engine";
import type { ExtensionManifest, WorkflowGraph } from "@mcp-moira/workflow-engine";

const MANIFEST: ExtensionManifest = {
  apiVersion: EXTENSION_API_VERSION,
  name: "corporate-messenger",
  version: "1.2.0",
  entrypoint: "dist/index.js",
  nodes: [
    {
      type: "corporate-messenger.send",
      title: "Send message",
      configSchema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string", minLength: 1 } },
      },
      outputSchema: { type: "object" },
    },
  ],
};

function graphWithCustomNode(): WorkflowGraph {
  return {
    metadata: { name: "Reach", version: "1.0.0", description: "test" },
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
}

function registryWithExtension(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.register(MANIFEST);
  return registry;
}

describe("The process default reaches callers that never passed a registry", () => {
  afterEach(() => {
    setActiveExtensionRegistry(null);
    setActiveExtensionRunnerClient(null);
  });

  test("a validator constructed with no arguments resolves custom types once a default is set", async () => {
    // Required state: every in-container caller behaves the same. Plausible wrong state: only the
    // call sites someone remembered to update do, and the rest reject the same workflow.
    const withoutDefault = await new GraphValidator().validateUnified(graphWithCustomNode());
    expect(
      withoutDefault.issues.some((issue) => /cannot be resolved here/.test(issue.message)),
    ).toBe(true);

    setActiveExtensionRegistry(registryWithExtension());

    const withDefault = await new GraphValidator().validateUnified(graphWithCustomNode());
    expect(withDefault.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(withDefault.valid).toBe(true);
  });

  test("an explicitly passed registry still wins over the process default", async () => {
    setActiveExtensionRegistry(new ExtensionRegistry());

    const explicit = await new GraphValidator(undefined, {
      extensionRegistry: registryWithExtension(),
    }).validateUnified(graphWithCustomNode());

    expect(explicit.valid).toBe(true);
  });

  test("clearing the default returns the process to having no custom types", async () => {
    setActiveExtensionRegistry(registryWithExtension());
    expect(getActiveExtensionRegistry()?.has("corporate-messenger.send")).toBe(true);

    setActiveExtensionRegistry(null);
    expect(getActiveExtensionRegistry()).toBeNull();
  });
});

describe("Snapshot for consumers outside the process", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-registry-"));
  });

  afterEach(() => {
    setActiveExtensionRegistry(null);
    setActiveExtensionRunnerClient(null);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("publishing writes a snapshot a separate process can read back", () => {
    const written = writeExtensionRegistrySnapshot(registryWithExtension(), stateDir);
    expect(written.written).toBe(true);

    const restored = readExtensionRegistrySnapshot(stateDir);
    expect(restored).not.toBeNull();
    expect(restored!.snapshot.extensions).toEqual([
      { name: "corporate-messenger", version: "1.2.0", nodeTypes: ["corporate-messenger.send"] },
    ]);
    expect(restored!.registry.has("corporate-messenger.send")).toBe(true);
  });

  test("a workflow validated from the snapshot is accepted, and without it is unresolved", async () => {
    writeExtensionRegistrySnapshot(registryWithExtension(), stateDir);
    const fromSnapshot = readExtensionRegistrySnapshot(stateDir)!;

    const resolved = await new GraphValidator(undefined, {
      extensionRegistry: fromSnapshot.registry,
    }).validateUnified(graphWithCustomNode());
    expect(resolved.valid).toBe(true);

    fs.rmSync(extensionRegistrySnapshotPath(stateDir));
    expect(readExtensionRegistrySnapshot(stateDir)).toBeNull();

    const unresolved = await new GraphValidator().validateUnified(graphWithCustomNode());
    expect(unresolved.valid).toBe(true);
    expect(unresolved.issues.some((issue) => /cannot be resolved here/.test(issue.message))).toBe(
      true,
    );
  });

  test("a damaged or foreign snapshot is treated as absent, not as a verdict", () => {
    fs.writeFileSync(extensionRegistrySnapshotPath(stateDir), "{ this is not json", "utf-8");
    expect(readExtensionRegistrySnapshot(stateDir)).toBeNull();

    fs.writeFileSync(
      extensionRegistrySnapshotPath(stateDir),
      JSON.stringify({ apiVersion: "moira.extensions/v99", extensions: [] }),
      "utf-8",
    );
    expect(readExtensionRegistrySnapshot(stateDir)).toBeNull();
  });

  test("publishing the active registry writes it, and publishing none removes it", () => {
    setActiveExtensionRegistry(registryWithExtension());
    expect(publishExtensionRegistry(stateDir).published).toBe(true);
    expect(fs.existsSync(extensionRegistrySnapshotPath(stateDir))).toBe(true);

    setActiveExtensionRegistry(null);
    expect(publishExtensionRegistry(stateDir).removed).toBe(true);
    expect(fs.existsSync(extensionRegistrySnapshotPath(stateDir))).toBe(false);
  });
});

describe("A snapshot that does not list a type cannot conclude the extension is absent", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-registry-stale-"));
  });

  afterEach(() => {
    setActiveExtensionRegistry(null);
    setActiveExtensionRunnerClient(null);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("a type missing from a published snapshot is unresolved, not an error", async () => {
    // The snapshot was written when this extension was not installed — a routine state, because
    // publication happens at defined moments and the file can lag behind. Treating "not in the
    // snapshot" as "extension absent" would make the CLI reject a workflow that the server
    // accepts, which is exactly the disagreement this unit exists to remove.
    writeExtensionRegistrySnapshot(new ExtensionRegistry(), stateDir);
    const fromSnapshot = readExtensionRegistrySnapshot(stateDir)!;

    const result = await new GraphValidator(undefined, {
      extensionRegistry: fromSnapshot.registry,
    }).validateUnified(graphWithCustomNode());

    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.issues.some((issue) => /cannot be resolved here/.test(issue.message))).toBe(true);
  });

  test("a live registry that lacks the type still reports the extension as not installed", async () => {
    const result = await new GraphValidator(undefined, {
      extensionRegistry: new ExtensionRegistry(),
    }).validateUnified(graphWithCustomNode());

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => /not currently installed/.test(issue.message))).toBe(true);
  });

  test("start-up publishes the process state even with no extensions installed", async () => {
    const outcome = await initializeExtensionsForProcess({
      runnerUrl: null,
      createClient: () => {
        throw new Error("no runner configured, so no client should be built");
      },
      publishSnapshot: true,
      stateDir,
    });

    expect(outcome.publication!.published).toBe(true);
    expect(outcome.synced).toBe(false);
    expect(fs.existsSync(extensionRegistrySnapshotPath(stateDir))).toBe(true);
    expect(readExtensionRegistrySnapshot(stateDir)!.snapshot.extensions).toEqual([]);
    // An installation without a runner ends start-up with no client, which is what makes a custom
    // node report "not installed" rather than fail in some other way.
    expect(getActiveExtensionRunnerClient()).toBeNull();
  });

  test("start-up with a runner leaves both the filled registry and the client that filled it", async () => {
    // Required state: a process finishes start-up able to execute exactly what its registry
    // accepts. Plausible wrong state: the client is built to read the runner and then dropped, so
    // the registry knows the type and execution has no way to reach it — the shape of a defect
    // that lived in two copies of this sequence and was observed by nothing.
    const client = {
      async listExtensions() {
        return [MANIFEST];
      },
      async invoke() {
        return { output: {} };
      },
    };

    const outcome = await initializeExtensionsForProcess({
      runnerUrl: "http://runner.local",
      createClient: () => client,
      publishSnapshot: false,
      stateDir,
    });

    expect(outcome.synced).toBe(true);
    expect(outcome.registered).toContain("corporate-messenger");
    expect(getActiveExtensionRegistry()!.has("corporate-messenger.send")).toBe(true);
    expect(getActiveExtensionRunnerClient()).toBe(client);
    // Not this process's job: the snapshot has a single writer.
    expect(fs.existsSync(extensionRegistrySnapshotPath(stateDir))).toBe(false);
  });

  test("a refused manifest is reported with its reasons, not dropped in silence", async () => {
    // Required state: the author of a bundle Moira refuses can find out why. Plausible wrong state:
    // the reasons are computed by manifest validation, returned to start-up and discarded there —
    // the runner hosts the bundle and calls it healthy, its node types simply never appear, and
    // nothing anywhere says the word "refused". Naming the extension and the reasons is what makes
    // the report usable; a bare count is what the process used to write.
    const reports: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const client = {
      async listExtensions() {
        return [
          {
            ...MANIFEST,
            nodes: [{ ...MANIFEST.nodes[0], configSchema: { type: "banana" } }],
          },
        ];
      },
      async invoke() {
        return { output: {} };
      },
    };

    const outcome = await initializeExtensionsForProcess({
      runnerUrl: "http://runner.local",
      createClient: () => client,
      publishSnapshot: false,
      stateDir,
      log: (message, fields) => reports.push({ message, fields }),
    });

    expect(outcome.registered).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.message).toContain("refused");
    expect(reports[0]!.fields.extension).toBe("corporate-messenger");
    expect(String(reports[0]!.fields.reasons)).toContain("nodes[0].configSchema");
  });

  test("an unreachable runner still leaves the client, so failure is reported per call", async () => {
    const failing = {
      async listExtensions(): Promise<unknown[]> {
        throw new Error("connection refused");
      },
      async invoke() {
        return { output: {} };
      },
    };

    const outcome = await initializeExtensionsForProcess({
      runnerUrl: "http://runner.local",
      createClient: () => failing,
      publishSnapshot: false,
      stateDir,
    });

    expect(outcome.synced).toBe(false);
    expect(outcome.reason).toContain("connection refused");
    expect(getActiveExtensionRunnerClient()).toBe(failing);
  });
});

describe("Built-in node types have one source", () => {
  test("the published list matches the types the graph schema declares", () => {
    // A private copy elsewhere is exactly how `materialize` came to be reported as unsupported.
    expect(isBuiltinNodeType("materialize")).toBe(true);
    expect(BUILTIN_NODE_TYPES).toContain("materialize");
    expect(isBuiltinNodeType("corporate-messenger.send")).toBe(false);
    expect(isBuiltinNodeType("not-a-type")).toBe(false);
  });
});
