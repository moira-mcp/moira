import { describe, expect, it, jest } from "@jest/globals";
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

describe("ordinary codespace and background process contracts", () => {
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
