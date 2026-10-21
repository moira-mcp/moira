import { afterEach, describe, expect, it } from "@jest/globals";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  encodeReference,
  decodeReference,
  type OwnerSelector,
} from "@mcp-moira/shared/workspace-references";
import { createWorkspaceClient } from "../../../packages/web-backend/src/services/workspace-client.js";
import {
  createWorkspaceToolHandler,
  workspacePurposeLogContext,
  type WorkspaceSemanticServices,
} from "../../../packages/mcp-server/src/tools/workspace-tools.js";
import { semanticFailure } from "../../../packages/mcp-server/src/tools/workspace-presentation.js";
import type { CommunicationPurposeDependencies } from "../../../packages/mcp-server/src/tools/workspace-communication.js";
type Fixture = {
  root: string;
  directory: string;
  stateRoot: string;
  socketPath: string;
  ownerSelector?: OwnerSelector;
  environment?: Record<string, string>;
};
const fixture = createRequire(import.meta.url)("../../fixtures/workspace-service.cjs") as {
  createFixture(): Fixture;
  start(value: Fixture): Promise<void>;
  dispose(value: Fixture): Promise<void>;
};
const resources: Fixture[] = [];
afterEach(async () => {
  for (const value of resources.splice(0)) await fixture.dispose(value);
});
const resourceId = "00000000-0000-4000-8000-000000000001";
const owner = { kind: "github" as const, resourceId };
const workspaceRef = encodeReference("workspace", {
  resourceId,
  provider: "github-codespaces",
  generation: 1,
});
async function service(prepare?: (value: Fixture) => void) {
  const value = fixture.createFixture();
  resources.push(value);
  value.ownerSelector = owner;
  prepare?.(value);
  await fixture.start(value);
  const workspace = createWorkspaceClient(value.socketPath);
  const resolved = { workspace, resourceId, owner };
  const services: WorkspaceSemanticServices = {
    invoke: async () => {
      throw new Error("Unexpected cloud call");
    },
    resolveWorkspace: async () => resolved,
    resolveOwner: async () => resolved,
    resolveWorkspaceResource: async () => resolved,
  };
  const execute = createWorkspaceToolHandler(services, {} as CommunicationPurposeDependencies);
  return {
    ...value,
    execute: (name: Parameters<typeof execute>[0], input: unknown) =>
      execute(name, input, "owned-user"),
  };
}
describe("semantic MCP tools with the actual workspace owner", () => {
  it("resumes only the supplied original repository operation without a fresh ID or guest dispatch", async () => {
    const reference = encodeReference("operation", {
      owner: { kind: "controller", deviceId: resourceId, connectionId: resourceId },
      requestId: "ws1-00000000-0000-4000-8000-000000000002",
      kind: "repository",
      journal: "repository-create",
    });
    const calls: unknown[][] = [];
    const unexpected = async (): Promise<never> => {
      throw new Error("Guest resolution must not run");
    };
    const services: WorkspaceSemanticServices = {
      resolveWorkspace: unexpected,
      resolveWorkspaceResource: unexpected,
      resolveOwner: unexpected,
      invoke: async (...args) => {
        calls.push(args);
        throw new Error("Lost original continuation reply");
      },
    };
    const execute = createWorkspaceToolHandler(services, {} as CommunicationPurposeDependencies);
    await expect(
      execute("operation_resume", { reference, request_id: "manual" }, "owned-user"),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
    const result = await execute("operation_resume", { reference }, "owned-user");
    expect(calls).toEqual([["owned-user", "operation_resume", { reference }]]);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { operation: reference, error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" } },
    });
  });
  it("collects a real failed command and complete output continuation without runner proofs", async () => {
    const value = await service();
    const result = await value.execute("command_run", {
      workspace: workspaceRef,
      command: { argv: ["bash", "-c", "printf abcdef; printf warning >&2; exit 23"] },
      max_stdout_bytes: 3,
    });
    expect(result.structuredContent).toMatchObject({
      state: "completed",
      outcome: { ok: false, result: { exitCode: 23 } },
      stdout: "abc",
      stderr: "warning",
      operation: expect.any(String),
      process: expect.any(String),
      stdout_cursor: expect.any(String),
    });
    expect(result.structuredContent).not.toHaveProperty("requestDigest");
    expect(result.structuredContent).not.toHaveProperty("request_id");
    const output = await value.execute("process_output", {
      process: result.structuredContent!.process,
      stream: "stdout",
      cursor: result.structuredContent!.stdout_cursor,
      max_bytes: 3,
    });
    expect(output.structuredContent).toMatchObject({ text: "def", total_bytes: 6 });
  });
  it("collects one original detached effect and gives two deliberate calls distinct intents", async () => {
    const value = await service();
    const input = {
      workspace: workspaceRef,
      command: { argv: ["bash", "-c", "printf x >> once; printf done"] },
      background: true,
    };
    const started = await value.execute("command_run", input);
    const reference = String(started.structuredContent!.operation);
    const collected = await value.execute("operation_get", { reference });
    expect(collected.structuredContent).toHaveProperty("operation", reference);
    const selected = decodeReference(reference, "operation");
    const workspace = createWorkspaceClient(value.socketPath);
    await workspace.json("owned-user", resourceId, {
      method: "GET",
      path: `/v1/operations/${selected.requestId}?waitMs=10000`,
    });
    expect((await value.execute("operation_get", { reference })).structuredContent).toMatchObject({
      state: "completed",
      outcome: { ok: true },
    });
    await value.execute("operation_get", { reference });
    expect(readFileSync(join(value.root, "once"), "utf8")).toBe("x");
    const second = await value.execute("command_run", { ...input, background: false });
    expect(second.structuredContent!.operation).not.toBe(reference);
    expect(readFileSync(join(value.root, "once"), "utf8")).toBe("xx");
  });
  it("guards text replacement and patching against the observed original while preserving binary-read refusal", async () => {
    const value = await service();
    expect(
      (
        await value.execute("file_create", {
          workspace: workspaceRef,
          path: "code.txt",
          text: "hello",
        })
      ).structuredContent,
    ).toMatchObject({ state: "completed", outcome: { ok: true } });
    const stat = await value.execute("file_stat", { workspace: workspaceRef, path: "code.txt" });
    const file = (stat.structuredContent!.stat as { file: string }).file;
    expect(
      (
        await value.execute("file_replace", {
          workspace: workspaceRef,
          path: "code.txt",
          text: "world",
          expected: { file },
        })
      ).structuredContent,
    ).toMatchObject({ state: "completed", outcome: { ok: true } });
    const stale = await value.execute("file_replace", {
      workspace: workspaceRef,
      path: "code.txt",
      text: "wrong",
      expected: { file },
    });
    expect(stale.isError).toBe(true);
    expect(readFileSync(join(value.root, "code.txt"), "utf8")).toBe("world");
    const patch = await value.execute("file_patch", {
      workspace: workspaceRef,
      files: [
        {
          path: "code.txt",
          expected: { text: "world" },
          replacements: [{ old_text: "world", new_text: "hello" }],
        },
      ],
    });
    expect(patch.structuredContent).toMatchObject({ state: "completed", outcome: { ok: true } });
    expect(
      (await value.execute("file_read", { workspace: workspaceRef, path: "code.txt" }))
        .structuredContent,
    ).toMatchObject({ text: "hello", file: expect.any(String) });
    writeFileSync(join(value.root, "binary"), Buffer.from([255]));
    expect(
      (await value.execute("file_read", { workspace: workspaceRef, path: "binary" })).isError,
    ).toBe(true);
  });
  it("keeps an accepted file effect without its terminal receipt uncertain, then collects rather than applying it again", async () => {
    let armed = "",
      observed = "";
    const value = await service((value) => {
      armed = join(value.directory, "armed");
      observed = join(value.directory, "observed");
      const fault = join(value.directory, "fault.cjs");
      writeFileSync(
        fault,
        `const fs=require('node:fs');const path=require('node:path');const promises=require('node:fs/promises');const original=promises.rename;promises.rename=async(from,to)=>{if(path.basename(String(to))==='result.json'&&fs.existsSync(${JSON.stringify(armed)})){fs.writeFileSync(${JSON.stringify(observed)},'result-publication');throw Object.assign(new Error('injected result storage failure'),{code:'EIO'})}return original(from,to)};require('node:module').syncBuiltinESMExports();`,
      );
      value.environment = { NODE_OPTIONS: `--require=${fault}` };
      writeFileSync(join(value.root, "target"), "original");
    });
    writeFileSync(armed, "armed");
    const result = await value.execute("file_patch", {
      workspace: workspaceRef,
      files: [
        {
          path: "target",
          expected: { text: "original" },
          replacements: [{ old_text: "original", new_text: "changed" }],
        },
      ],
    });
    expect(readFileSync(observed, "utf8")).toBe("result-publication");
    expect(readFileSync(join(value.root, "target"), "utf8")).toBe("changed");
    const operation = String(result.structuredContent!.operation);
    const original = decodeReference(operation, "operation");
    expect(existsSync(join(value.stateRoot, "requests", original.requestId, "accepted.json"))).toBe(
      true,
    );
    expect(existsSync(join(value.stateRoot, "requests", original.requestId, "result.json"))).toBe(
      false,
    );
    expect(result.isError).toBe(true);
    unlinkSync(armed);
    const collected = await value.execute("operation_get", { reference: operation });
    expect(collected.structuredContent).toMatchObject({ state: "unconfirmed", operation });
    expect(readFileSync(join(value.root, "target"), "utf8")).toBe("changed");
  });
  it("retains a definite non-start and supports an explicitly opened named session", async () => {
    const value = await service();
    const refused = await value.execute("command_run", {
      workspace: workspaceRef,
      command: { argv: ["true"] },
      cwd: "../outside",
    });
    expect(refused.structuredContent).toMatchObject({
      state: "completed",
      outcome: { ok: false, result: { reason: "COMMAND_START_REJECTED" } },
      operation: expect.any(String),
    });
    const result = await value.execute("command_run", {
      workspace: workspaceRef,
      command: { script: "printf session-ready" },
      session: { name: "s".repeat(65), mode: "open" },
    });
    expect(result.structuredContent).toMatchObject({
      state: "completed",
      outcome: { ok: true },
      stdout: "session-ready",
    });
  });
  it("returns a distinctive owner-native object by identity without cloud rendering or file acquisition", async () => {
    const native = {
      content: [
        { type: "text", text: "owner-text-not-json" },
        { type: "resource_link", uri: "https://owner.example/exact", name: "owned" },
      ],
      structuredContent: { ownerOnly: "opaque" },
      isError: true,
    };
    const selected = { workspace: { json: async () => native }, resourceId, owner };
    const services: WorkspaceSemanticServices = {
      resolveWorkspace: async () => selected,
      resolveWorkspaceResource: async () => selected,
      resolveOwner: async () => selected,
      invoke: async () => {
        throw new Error("unexpected");
      },
    };
    expect(
      await createWorkspaceToolHandler(services, {} as CommunicationPurposeDependencies)(
        "file_stat",
        { workspace: workspaceRef, path: "file" },
        "owned-user",
      ),
    ).toBe(native);
  });
  it("distinguishes a confirmed refusal from wire uncertainty while retaining the original operation", () => {
    const operation = encodeReference("operation", {
      owner,
      requestId: "ws1-00000000-0000-4000-8000-000000000002",
      kind: "command",
    });
    expect(semanticFailure(new Error("private transport details"), operation)).toMatchObject({
      isError: true,
      structuredContent: { operation, error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" } },
    });
    expect(
      semanticFailure({ details: { error: { code: "FILE_REJECTED" } } }, operation),
    ).toMatchObject({ structuredContent: { operation, error: { code: "FILE_REJECTED" } } });
    expect(JSON.stringify(semanticFailure(new Error("secret"), operation))).not.toContain("secret");
    expect(workspacePurposeLogContext("command_run")).toEqual({
      inputData: { workspace_tool: "command_run" },
      resourceIds: {},
    });
  });
});
