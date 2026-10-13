import { afterEach, describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import { createWorkspaceRequestId } from "@mcp-moira/shared/workspace-request-id";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  TOOL_DEFINITIONS,
  getToolJsonSchema,
} from "../../../packages/mcp-server/src/tools/tool-definitions.js";
import {
  codespaceSchema,
  codespaceProcessSchema,
  CODESPACE_PROCESS_ACTION_REQUEST_SCHEMAS,
  CODESPACE_ACTION_REQUEST_SCHEMAS,
} from "../../../packages/mcp-server/src/tools/tool-schemas.js";
import {
  codespaceProcessLogContext,
  executeCodespaceProcess,
} from "../../../packages/mcp-server/src/tools/codespace-process.js";
import {
  parseCodespaceToolParams,
  type CodespaceToolServices,
} from "../../../packages/mcp-server/src/tools/manage-codespaces.js";
import {
  executeWorkspaceAction,
  collectWorkspaceCommand,
} from "../../../packages/mcp-server/src/tools/codespace-workspace.js";
import { createWorkspaceClient } from "../../../packages/web-backend/src/services/workspace-client.js";

type Fixture = { root: string; socketPath: string };
const fixture = createRequire(import.meta.url)("../../fixtures/workspace-service.cjs") as {
  createFixture(): Fixture;
  start(value: Fixture): Promise<void>;
  dispose(value: Fixture): Promise<void>;
};
const resources: Fixture[] = [];
afterEach(async () => {
  for (const value of resources.splice(0)) await fixture.dispose(value);
});
async function service() {
  const value = fixture.createFixture();
  resources.push(value);
  await fixture.start(value);
  const workspace = createWorkspaceClient(value.socketPath);
  return { ...value, workspace, services: { workspace } as CodespaceToolServices };
}
const codespaceId = "00000000-0000-4000-8000-000000000001";

describe("workspace-backed codespace and process tools", () => {
  it("collects a real failed command and output windows without exposing runner proofs", async () => {
    const value = await service();
    const requestId = createWorkspaceRequestId();
    const result = await executeWorkspaceAction(
      parseCodespaceToolParams({
        action: "exec",
        codespace_id: codespaceId,
        request_id: requestId,
        argv: ["bash", "-c", "printf abcdef; printf warning >&2; exit 23"],
        max_stdout_bytes: 3,
      }),
      "owned-user",
      value.workspace,
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        state: "failed",
        exitCode: 23,
        stdout: "abc",
        stderr: "warning",
        stdout_truncated: true,
        stdout_total_bytes: 6,
        request_id: requestId,
      },
    });
    expect(result.structuredContent).not.toHaveProperty("requestDigest");
    const output = await executeCodespaceProcess(
      {
        action: "read",
        request: {
          codespace_id: codespaceId,
          process_id: requestId,
          stream: "stdout",
          offset: 3,
          length: 3,
        },
      },
      "owned-user",
      value.services,
    );
    expect(output.structuredContent).toMatchObject({ text: "def", offset: 3, total_bytes: 6 });
  });

  it("uses the same detached identity for collection and replay, with one physical side effect", async () => {
    const value = await service();
    const requestId = createWorkspaceRequestId();
    const request = {
      codespace_id: codespaceId,
      request_id: requestId,
      argv: ["bash", "-c", "printf x >> once; printf done"],
      session_start: false,
      session_end: false,
    };
    const started = await executeCodespaceProcess(
      { action: "start", request },
      "owned-user",
      value.services,
    );
    expect(started.structuredContent).toMatchObject({
      process_id: requestId,
      request_id: requestId,
    });
    expect(
      (
        await collectWorkspaceCommand(value.workspace, "owned-user", codespaceId, requestId, {
          waitMs: 10_000,
        })
      ).structuredContent,
    ).toMatchObject({ state: "succeeded", stdout: "done" });
    await executeCodespaceProcess({ action: "start", request }, "owned-user", value.services);
    expect(readFileSync(join(value.root, "once"), "utf8")).toBe("x");
    const status = await executeCodespaceProcess(
      { action: "get", request: { codespace_id: codespaceId, process_id: requestId } },
      "owned-user",
      value.services,
    );
    expect(status.structuredContent).toMatchObject({
      state: "succeeded",
      exitCode: 0,
      process_id: requestId,
    });
    expect(status.structuredContent).not.toHaveProperty("requestDigest");
  });

  it("writes, patches and reads real files while preserving stale-precondition and binary-read causes", async () => {
    const value = await service();
    const requestId = createWorkspaceRequestId();
    const write = {
      action: "write",
      codespace_id: codespaceId,
      request_id: requestId,
      path: "code.txt",
      expected: { exists: false },
      text: "hello",
    };
    expect(
      (await executeWorkspaceAction(parseCodespaceToolParams(write), "owned-user", value.workspace))
        .structuredContent,
    ).toMatchObject({ state: "succeeded" });
    await executeWorkspaceAction(parseCodespaceToolParams(write), "owned-user", value.workspace);
    const stale = await executeWorkspaceAction(
      parseCodespaceToolParams({ ...write, request_id: createWorkspaceRequestId(), text: "wrong" }),
      "owned-user",
      value.workspace,
    );
    expect(stale).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "FILE_REJECTED", reason: "precondition" } },
    });
    expect(readFileSync(join(value.root, "code.txt"), "utf8")).toBe("hello");
    const patch = await executeWorkspaceAction(
      parseCodespaceToolParams({
        action: "apply_patch",
        codespace_id: codespaceId,
        request_id: createWorkspaceRequestId(),
        files: [
          {
            path: "code.txt",
            expected: {
              exists: true,
              size_bytes: 5,
              sha256: createHash("sha256").update("hello").digest("hex"),
            },
            edits: [{ start: 0, end: 5, text: "world" }],
          },
        ],
      }),
      "owned-user",
      value.workspace,
    );
    expect(patch.structuredContent).toMatchObject({ state: "succeeded" });
    const read = await executeWorkspaceAction(
      parseCodespaceToolParams({
        action: "read",
        codespace_id: codespaceId,
        path: "code.txt",
        offset: 0,
        length: 5,
      }),
      "owned-user",
      value.workspace,
    );
    expect(read.structuredContent).toMatchObject({ text: "world", total_bytes: 5 });
    writeFileSync(join(value.root, "binary"), Buffer.from([255]));
    expect(
      await executeWorkspaceAction(
        parseCodespaceToolParams({
          action: "read",
          codespace_id: codespaceId,
          path: "binary",
          offset: 0,
          length: 1,
        }),
        "owned-user",
        value.workspace,
      ),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "CODESPACE_BINARY_READ_REQUIRES_DOWNLOAD" } },
    });
  });

  it("reports a definite non-start without inventing lost execution", async () => {
    const value = await service();
    const requestId = createWorkspaceRequestId();
    const result = await executeWorkspaceAction(
      parseCodespaceToolParams({
        action: "exec",
        codespace_id: codespaceId,
        request_id: requestId,
        argv: ["true"],
        cwd: "../outside",
      }),
      "owned-user",
      value.workspace,
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        state: "not_started",
        reason: "COMMAND_REJECTED",
        request_id: requestId,
      },
    });
  });

  it("opens a real session with a name beyond the removed MCP-only ceiling", async () => {
    const value = await service();
    const result = await executeWorkspaceAction(
      parseCodespaceToolParams({
        action: "exec",
        codespace_id: codespaceId,
        request_id: createWorkspaceRequestId(),
        session: "s".repeat(65),
        session_start: true,
        script: "printf session-ready",
      }),
      "owned-user",
      value.workspace,
    );
    expect(result.structuredContent).toMatchObject({ state: "succeeded", stdout: "session-ready" });
  });

  it("publishes a separate discoverable process tool with native stdin", () => {
    const definition = TOOL_DEFINITIONS.find(
      (tool) => (tool.name as string) === "codespace_process",
    );
    expect(definition).toBeDefined();
    const schema = getToolJsonSchema(definition!) as {
      type: string;
      required: string[];
      properties: Record<string, { enum?: string[]; type?: string }>;
    };
    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema.required).toContain("codespace_id");
    expect(schema.properties.action.enum).toEqual(["start", "get", "read", "stop"]);
    expect(schema.properties.stdin_file.type).toBe("object");
    expect(definition!._meta).toEqual({ "openai/fileParams": ["stdin_file"] });
  });

  it("refuses background and cancellation controls on ordinary exec", () => {
    expect(
      codespaceSchema.safeParse({
        action: "exec",
        codespace_id: codespaceId,
        argv: ["true"],
        background: true,
      }).success,
    ).toBe(false);
    expect(
      codespaceSchema.safeParse({
        action: "exec",
        codespace_id: codespaceId,
        operation_id: codespaceId,
        cancel: true,
      }).success,
    ).toBe(false);
  });

  it("publishes explicit deletion confirmation without an agent generation counter", () => {
    expect(
      codespaceSchema.safeParse({
        action: "delete",
        codespace_id: codespaceId,
        confirm_delete: true,
      }).success,
    ).toBe(true);
    expect(
      codespaceSchema.safeParse({
        action: "delete",
        codespace_id: codespaceId,
        confirm_delete: true,
        expected_generation: 1,
      }).success,
    ).toBe(false);
  });

  it("requires addressed process identity and refuses command fields on inspection", () => {
    const requestId = createWorkspaceRequestId();
    expect(codespaceProcessSchema.safeParse({ action: "start", argv: ["true"] }).success).toBe(
      false,
    );
    expect(
      CODESPACE_PROCESS_ACTION_REQUEST_SCHEMAS.get.safeParse({
        codespace_id: codespaceId,
        process_id: requestId,
        argv: ["secret"],
      }).success,
    ).toBe(false);
    expect(
      CODESPACE_PROCESS_ACTION_REQUEST_SCHEMAS.start.safeParse({
        codespace_id: codespaceId,
        request_id: requestId,
        argv: ["cat"],
        stdin_text: "secret",
        stdin_file: { file_id: "f", download_url: "https://files.example/file" },
      }).success,
    ).toBe(false);
  });

  it("refuses archived UUIDs on command submission, collection and process control", () => {
    for (const input of [
      { action: "exec", argv: ["true"] },
      { action: "exec" },
      { action: "write", path: "file", text: "x", expected: { exists: false } },
    ] as const) {
      const { action, ...request } = input;
      expect(
        CODESPACE_ACTION_REQUEST_SCHEMAS[action].safeParse({
          ...request,
          codespace_id: codespaceId,
          request_id: codespaceId,
        }).success,
      ).toBe(false);
    }
    for (const input of [
      { action: "start", argv: ["true"], request_id: codespaceId },
      { action: "get", request_id: codespaceId },
      { action: "get", process_id: codespaceId },
      { action: "read", process_id: codespaceId, stream: "stdout", offset: 0, length: 1 },
      { action: "stop", process_id: codespaceId },
    ]) {
      expect(
        codespaceProcessSchema.safeParse({ ...input, codespace_id: codespaceId }).success,
      ).toBe(false);
    }
  });

  it("logs only opaque addressed identity for background commands", () => {
    const requestId = createWorkspaceRequestId();
    const logged = codespaceProcessLogContext({
      action: "start",
      codespace_id: codespaceId,
      process_id: requestId,
      argv: ["secret"],
      env: { TOKEN: "secret" },
      stdin_text: "secret",
      stdin_file: { download_url: "https://secret.example/file" },
      script: "secret",
    });
    expect(logged).toEqual({
      inputData: { codespace_action: "start" },
      resourceIds: { codespaceId, requestId },
    });
    expect(JSON.stringify(logged)).not.toContain("secret");
  });
});
