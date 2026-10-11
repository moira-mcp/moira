import { describe, expect, it, jest } from "@jest/globals";
import { CodespaceResourceError } from "@mcp-moira/shared";
import {
  TOOL_DEFINITIONS,
  getToolJsonSchema,
} from "../../../packages/mcp-server/src/tools/tool-definitions.js";
import {
  codespaceSchema,
  codespaceProcessSchema,
  CODESPACE_PROCESS_ACTION_REQUEST_SCHEMAS,
} from "../../../packages/mcp-server/src/tools/tool-schemas.js";
import {
  codespaceProcessLogContext,
  executeCodespaceProcess,
} from "../../../packages/mcp-server/src/tools/codespace-process.js";
import type { CodespaceToolServices } from "../../../packages/mcp-server/src/tools/manage-codespaces.js";

const codespaceId = "00000000-0000-4000-8000-000000000001";
const processId = "00000000-0000-4000-8000-000000000002";

describe("ordinary codespace and background process contracts", () => {
  it.each([
    ["session_unavailable_not_started", "CODESPACE_SESSION_UNAVAILABLE"],
    ["session_limit_not_started", "CODESPACE_POLICY_LIMIT"],
  ])("collects asynchronous %s with its precise refusal code", async (lastOutcome, code) => {
    const services = {
      operation: {
        lookupRequest: jest.fn(async () => ({
          operation: {
            id: processId,
            resourceId: codespaceId,
            kind: "exec",
            requestId: processId,
            inputReference: "private-input",
            state: "cancelled",
            lastOutcome,
            exitCode: null,
            startedAt: null,
          },
          result: null,
        })),
      },
    } as unknown as CodespaceToolServices;
    const response = await executeCodespaceProcess(
      { action: "get", request: { codespace_id: codespaceId, request_id: processId } },
      "owned-user",
      services,
    );
    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        process_id: processId,
        request_id: processId,
        accepted: true,
        phase: "not_started",
        started_at: null,
        error: { code, retryable: false },
      },
    });
    expect(JSON.stringify(response)).not.toContain(lastOutcome);
  });

  it("projects the same durable acceptance and uncertain phase on process start and caller-ID lookup", async () => {
    const response = {
      operation: {
        id: processId,
        resourceId: codespaceId,
        kind: "exec",
        requestId: processId,
        inputReference: "private-input",
        state: "reserved",
        exitCode: null,
        admissionDeadlineAt: 1000,
        startedAt: null,
        runtimeMs: 5000,
        resultExpiresAt: null,
      },
      result: null,
    };
    const execute = jest.fn(async () => response);
    const lookupRequest = jest.fn(
      async (_userId: string, _codespaceId: string, _requestId: string) => ({
        ...response,
        operation: { ...response.operation, state: "reconcile_pending" },
      }),
    );
    const services = { operation: { execute, lookupRequest } } as unknown as CodespaceToolServices;
    const started = await executeCodespaceProcess(
      {
        action: "start",
        request: {
          codespace_id: codespaceId,
          request_id: processId,
          argv: ["serve"],
          session_start: false,
          session_end: false,
        },
      },
      "owned-user",
      services,
    );
    expect(started.structuredContent).toMatchObject({
      process_id: processId,
      request_id: processId,
      accepted: true,
      phase: "accepted",
      started_at: null,
      admission_deadline_at: 1000,
      runtime_ms: 5000,
    });
    const collected = await executeCodespaceProcess(
      {
        action: "get",
        request: {
          codespace_id: codespaceId,
          request_id: processId,
        },
      },
      "owned-user",
      services,
    );
    expect(collected.structuredContent).toMatchObject({
      process_id: processId,
      request_id: processId,
      accepted: true,
      phase: "outcome_unknown",
      state: "unknown",
      started_at: null,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(lookupRequest).toHaveBeenCalledWith("owned-user", codespaceId, processId);
  });

  it("keeps the accepted process identity after a typed uncertain start failure", async () => {
    const execute = jest.fn(async () => {
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        "private-runtime-generation-99",
        "The connection was interrupted; inspect the accepted process.",
        false,
        processId,
      );
    });
    const services = { operation: { execute } } as unknown as CodespaceToolServices;
    const response = await executeCodespaceProcess(
      {
        action: "start",
        request: {
          codespace_id: codespaceId,
          request_id: processId,
          argv: ["serve"],
          session_start: false,
          session_end: false,
        },
      },
      "owned-user",
      services,
    );
    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        process_id: processId,
        error: {
          code: "CODESPACE_PROVIDER_UNAVAILABLE",
          message:
            "The codespace provider is unavailable. The connection was interrupted; inspect the accepted process.",
        },
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(response.structuredContent).not.toHaveProperty("operation_id");
    expect(response.structuredContent).not.toHaveProperty("operation");
    expect(JSON.stringify(response)).not.toMatch(/private-runtime|resourceGeneration|remoteMarker/);
  });

  it.each([
    ["leading byte of Russian stdout", Buffer.from("я"), 0, 1, "�"],
    ["trailing byte of Russian stdout", Buffer.from("я"), 1, 1, "�"],
    ["invalid UTF-8 command bytes", Buffer.from([0xff, 0x61]), 0, 2, "�a"],
  ] as const)(
    "reads %s with ordinary retained-stream text semantics",
    async (_name, bytes, offset, length, text) => {
      const readOutput = jest.fn<NonNullable<CodespaceToolServices["operation"]>["readOutput"]>(
        async () => ({
          stream: "stdout",
          offset,
          totalBytes: bytes.length,
          bytes: bytes.subarray(offset, offset + length),
        }),
      );
      const execute = jest.fn();
      const services = {
        operation: {
          get: jest.fn(() => ({ resourceId: codespaceId, kind: "exec" })),
          readOutput,
          execute,
        },
      } as unknown as CodespaceToolServices;
      const result = await executeCodespaceProcess(
        {
          action: "read",
          request: {
            codespace_id: codespaceId,
            process_id: codespaceId,
            stream: "stdout",
            offset,
            length,
          },
        },
        "owned-user",
        services,
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        process_id: codespaceId,
        stream: "stdout",
        offset,
        total_bytes: bytes.length,
        text,
      });
      expect(readOutput).toHaveBeenCalledWith("owned-user", codespaceId, {
        stream: "stdout",
        offset,
        length,
      });
      expect(readOutput).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
    },
  );

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
    expect(codespaceProcessSchema.safeParse({ action: "start", argv: ["true"] }).success).toBe(
      false,
    );
    expect(
      CODESPACE_PROCESS_ACTION_REQUEST_SCHEMAS.get.safeParse({
        codespace_id: codespaceId,
        process_id: codespaceId,
        argv: ["secret"],
      }).success,
    ).toBe(false);
    expect(
      CODESPACE_PROCESS_ACTION_REQUEST_SCHEMAS.start.safeParse({
        codespace_id: codespaceId,
        argv: ["cat"],
        stdin_text: "secret",
        stdin_file: { file_id: "f", download_url: "https://files.example/file" },
      }).success,
    ).toBe(false);
  });

  it("logs only opaque addressed identity for background commands", () => {
    const logged = codespaceProcessLogContext({
      action: "start",
      codespace_id: codespaceId,
      process_id: codespaceId,
      argv: ["secret"],
      env: { TOKEN: "secret" },
      stdin_text: "secret",
      stdin_file: { download_url: "https://secret.example/file" },
      script: "secret",
    });
    expect(logged).toEqual({
      inputData: { codespace_action: "start" },
      resourceIds: { codespaceId, operationId: codespaceId },
    });
    expect(JSON.stringify(logged)).not.toContain("secret");
  });
});
