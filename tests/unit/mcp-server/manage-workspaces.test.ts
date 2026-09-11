import { describe, expect, it, jest } from "@jest/globals";
import {
  WorkspaceResourceError,
  type WorkspaceOperationRecord,
  type WorkspaceResourceRecord,
} from "@mcp-moira/shared";

import {
  executeWorkspaceTool,
  setWorkspaceToolFailureReporterForTests,
  workspaceToolLogContext,
  type WorkspaceToolServices,
} from "../../../packages/mcp-server/src/tools/manage-workspaces.js";

const USER_ID = "user-a";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "00000000-0000-4000-8000-000000000002";

function workspace(overrides: Partial<WorkspaceResourceRecord> = {}): WorkspaceResourceRecord {
  return {
    id: WORKSPACE_ID,
    userId: USER_ID,
    connectionId: "secret-connection",
    authorizationGeneration: 7,
    provider: "github-codespaces",
    repositoryId: "42",
    repositoryFullName: "owner/repository",
    requestedRef: "main",
    operationMarker: "secret-marker",
    providerResourceName: "secret-provider-name",
    externalOwnerId: "secret-owner",
    billableOwnerId: "secret-billing",
    machine: {
      name: "basicLinux32gb",
      displayName: "2 cores, 8 GB RAM",
      operatingSystem: "linux",
      cpuCores: 2,
      memoryBytes: 8 * 1024 ** 3,
      storageBytes: 32 * 1024 ** 3,
    },
    state: "usable",
    retentionPolicy: "persistent",
    desiredState: "running",
    observedState: "running",
    generation: 3,
    createDeadlineAt: 100,
    remoteExpiresAt: 200,
    cleanupDeadlineAt: null,
    claimId: "secret-claim",
    claimExpiresAt: null,
    lastOutcome: "verified_usable",
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function operation(
  kind: "exec" | "stat" | "search" | "read" | "write" | "apply_patch" | "upload" | "download",
): WorkspaceOperationRecord {
  return {
    id: OPERATION_ID,
    userId: USER_ID,
    resourceId: WORKSPACE_ID,
    resourceGeneration: 3,
    authorizationGeneration: 7,
    provider: "github-codespaces",
    providerResourceName: "secret-provider-name",
    remoteMarker: "secret-operation-marker",
    kind,
    state: "succeeded" as const,
    inputBytes: 0,
    stdoutLimitBytes: 1024,
    stderrLimitBytes: 1024,
    outputBytes: 0,
    exitCode: kind === "exec" ? 0 : null,
    remoteCleanupPending: 0 as const,
    resultExpiresAt: 500,
    deadlineAt: 400,
    claimId: null,
    claimExpiresAt: null,
    lastOutcome: "remote_result_recorded",
    createdAt: 30,
    updatedAt: 40,
  };
}

function services(overrides: Partial<WorkspaceToolServices> = {}): WorkspaceToolServices {
  return {
    observability: {
      readiness: jest.fn(async () => ({
        state: "ready" as const,
        reason: null,
        provider: "github-codespaces",
        configuration: "available" as const,
        resources_enabled: true,
        controls: [],
        connector: { state: "available" as const, reason: null },
        reconciliation: { due_resources: 0, due_operations: 0, oldest_due_age_ms: null },
        usage: {
          active_resources: 1,
          max_active_resources: 4,
          active_operations: 0,
          max_active_operations: 20,
          transfer_live_bytes: 0,
          max_transfer_live_bytes: null,
        },
        checked_at: 50,
      })),
    },
    connection: {
      getStatus: jest.fn(() => ({
        state: "connected" as const,
        reason: null,
        settingsUrl: "https://moira.example/settings/integrations",
        installationUrl: null,
        account: null,
        installations: [],
        repositories: [],
        canConnect: false,
        canDisconnect: true,
      })),
    },
    resource: {
      listRepositories: jest.fn(() => [{ id: "42", fullName: "owner/repository", private: true }]),
      listResources: jest.fn(() => [workspace()]),
      getWorkspace: jest.fn(() => workspace()),
      create: jest.fn(async () => ({
        resource: workspace(),
        lifecycleCapability: "secret-capability",
      })),
      startWorkspace: jest.fn(async () => workspace()),
      stopWorkspace: jest.fn(async () =>
        workspace({
          state: "stopped",
          desiredState: "stopped",
          observedState: "stopped",
          generation: 4,
        }),
      ),
      deleteWorkspace: jest.fn(async () =>
        workspace({
          state: "deleted",
          desiredState: "deleted",
          observedState: "absent",
          generation: 4,
        }),
      ),
    },
    operation: {
      get: jest.fn(() => null),
      reconcile: jest.fn(async () => null),
      execute: jest.fn(async () => ({
        operation: operation("exec"),
        result: { state: "succeeded" as const, stdout: "ok\n", stderr: "", exitCode: 0 },
      })),
      executeNativeReference: jest.fn(async () => ({
        operation: operation("exec"),
        result: { state: "succeeded" as const, stdout: "native\n", stderr: "", exitCode: 0 },
      })),
    },
    file: {
      reconcile: jest.fn(async () => {
        throw new Error("unexpected reconciliation");
      }),
      execute: jest.fn(async () => ({
        operation: operation("stat"),
        result: {
          action: "stat" as const,
          stat: {
            path: "package.json",
            type: "file" as const,
            size: 12,
            mode: 0o644,
            modifiedAt: 45,
            version: { size: 12, sha256: "a".repeat(64), modifiedAt: 45 },
          },
        },
      })),
      uploadReference: jest.fn(async () => ({
        operation: operation("upload"),
        result: {
          action: "upload" as const,
          path: "input.txt",
          previous: null,
          current: { size: 12, sha256: "b".repeat(64), modifiedAt: 46 },
        },
      })),
      downloadReference: jest.fn(async () => ({
        operation: operation("download"),
        transfer: {
          referenceId: `workspace-file://${"x".repeat(43)}`,
          fileName: "result.txt",
          mimeType: "text/plain",
          size: 12,
          sha256: "c".repeat(64),
          expiresAt: 900,
        },
      })),
    },
    ...overrides,
  } as unknown as WorkspaceToolServices;
}

function data(result: Awaited<ReturnType<typeof executeWorkspaceTool>>) {
  return result.structuredContent as Record<string, unknown>;
}

describe("workspace MCP adapter", () => {
  it.each(["private-token", "x".repeat(10000), `${WORKSPACE_ID}\nprivate-source`, 42, null])(
    "omits malformed identifiers from pre-validation logging (%#)",
    (identifier) => {
      expect(
        workspaceToolLogContext("workspace_exec", {
          workspace_id: identifier,
          operation_id: identifier,
        }),
      ).toEqual({ inputData: { workspace_tool: "workspace_exec" }, resourceIds: {} });
    },
  );

  it("logs only opaque workspace/operation identity and never workspace input", () => {
    const projected = workspaceToolLogContext("workspace_upload", {
      workspace_id: WORKSPACE_ID,
      operation_id: OPERATION_ID,
      path: "private/source.ts",
      query: "secret query",
      text: "secret source",
      argv: ["print-secret"],
      file: {
        file_id: "sediment://file_private",
        download_url: "https://oaiusercontent.com/private-token",
        file_name: "private.txt",
      },
    });

    expect(projected).toEqual({
      inputData: { workspace_tool: "workspace_upload" },
      resourceIds: { workspaceId: WORKSPACE_ID, operationId: OPERATION_ID },
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /secret query|secret source|print-secret|private-token|private\.txt|sediment/,
    );
  });

  it("lists and gets reusable workspace state without internal authority fields", async () => {
    const dependencies = services();
    dependencies.resource!.getWorkspace = jest.fn(() =>
      workspace({ lastOutcome: "provider-private-diagnostic" }),
    );
    const listed = await executeWorkspaceTool("workspace_list", {}, USER_ID, dependencies);
    const fetched = await executeWorkspaceTool(
      "workspace_get",
      { workspace_id: WORKSPACE_ID },
      USER_ID,
      dependencies,
    );

    expect(data(listed)).toMatchObject({
      readiness: { state: "connected" },
      instance: { state: "ready", provider: "github-codespaces", connector: "available" },
      repositories: [{ repository_id: "42", name: "owner/repository", private: true }],
      workspaces: [{ workspace_id: WORKSPACE_ID, generation: 3 }],
    });
    expect(data(fetched)).toMatchObject({ workspace: { workspace_id: WORKSPACE_ID } });
    const serialized = JSON.stringify([listed, fetched]);
    for (const secret of [
      "secret-connection",
      "secret-marker",
      "secret-provider-name",
      "secret-owner",
      "secret-billing",
      "secret-claim",
      "provider-private-diagnostic",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps creation capability private and distinguishes stop from confirmed delete", async () => {
    const dependencies = services();
    const created = await executeWorkspaceTool(
      "workspace_create",
      { repository_id: "42", ref: "main" },
      USER_ID,
      dependencies,
    );
    const stopped = await executeWorkspaceTool(
      "workspace_stop",
      { workspace_id: WORKSPACE_ID },
      USER_ID,
      dependencies,
    );
    const deleted = await executeWorkspaceTool(
      "workspace_delete",
      { workspace_id: WORKSPACE_ID, expected_generation: 4, confirm_delete: true },
      USER_ID,
      dependencies,
    );

    expect(JSON.stringify(created)).not.toContain("secret-capability");
    expect(data(stopped)).toMatchObject({ data_preserved: true });
    expect(data(deleted)).toMatchObject({ data_preserved: false });
    expect(dependencies.resource?.deleteWorkspace).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, 4);
  });

  it("uses exactly one inline or native stdin path without returning the native reference", async () => {
    const dependencies = services();
    await executeWorkspaceTool(
      "workspace_exec",
      {
        workspace_id: WORKSPACE_ID,
        argv: ["node", "script.js"],
        cwd: ".",
        timeout_seconds: 30,
        stdin_text: "hello",
      },
      USER_ID,
      dependencies,
    );
    const native = await executeWorkspaceTool(
      "workspace_exec",
      {
        workspace_id: WORKSPACE_ID,
        argv: ["node", "script.js"],
        cwd: ".",
        timeout_seconds: 30,
        stdin_file: {
          file_id: "sediment://file_00000000000000000000000000000000",
          download_url: "https://oaiusercontent.com/private-token",
          file_name: "input.bin",
          mime_type: "application/octet-stream",
          size_bytes: 12,
        },
      },
      USER_ID,
      dependencies,
    );

    expect(dependencies.operation?.execute).toHaveBeenCalledWith(
      USER_ID,
      WORKSPACE_ID,
      expect.objectContaining({
        stdin: { kind: "inline", bytes: Buffer.from("hello") },
      }),
    );
    expect(dependencies.operation?.executeNativeReference).toHaveBeenCalledWith(
      USER_ID,
      WORKSPACE_ID,
      expect.objectContaining({ argv: ["node", "script.js"] }),
      {
        fileId: "sediment://file_00000000000000000000000000000000",
        downloadUrl: "https://oaiusercontent.com/private-token",
        fileName: "input.bin",
        mimeType: "application/octet-stream",
        declaredSize: 12,
      },
    );
    expect(JSON.stringify(native)).not.toContain("private-token");
    expect(JSON.stringify(native)).not.toContain("sediment://");
  });

  it("reconciles a returned operation ID without dispatching a duplicate command", async () => {
    let current: WorkspaceOperationRecord = { ...operation("exec"), state: "reconcile_pending" };
    const execute = jest.fn();
    const reconcile = jest.fn(async () => {
      current = { ...operation("exec"), state: "succeeded" as const };
      return { state: "succeeded" as const, stdout: "recovered\n", stderr: "", exitCode: 0 };
    });
    const base = services();
    const dependencies = services({
      operation: {
        ...base.operation!,
        get: jest.fn(() => current),
        reconcile,
        execute,
      },
    });

    const resumed = await executeWorkspaceTool(
      "workspace_exec",
      { workspace_id: WORKSPACE_ID, operation_id: OPERATION_ID },
      USER_ID,
      dependencies,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(USER_ID, OPERATION_ID);
    expect(data(resumed)).toMatchObject({
      operation: { operation_id: OPERATION_ID, state: "succeeded" },
      result: { stdout: "recovered\n", exit_code: 0 },
    });
  });

  it.each([
    ["failed", "WORKSPACE_OPERATION_FAILED"],
    ["cancelled", "WORKSPACE_OPERATION_CANCELLED"],
    ["timed_out", "WORKSPACE_OPERATION_TIMED_OUT"],
  ] as const)(
    "exposes terminal exec %s as a tool error with its operation identity",
    async (state, code) => {
      const base = services();
      const response = await executeWorkspaceTool(
        "workspace_exec",
        { workspace_id: WORKSPACE_ID, argv: ["node", "test.js"], cwd: ".", timeout_seconds: 30 },
        USER_ID,
        services({
          operation: {
            ...base.operation!,
            execute: jest.fn(async () => ({
              operation: { ...operation("exec"), state, exitCode: 1 },
              result: { state, stdout: "", stderr: "test failed", exitCode: 1 },
            })),
          },
        }),
      );
      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          operation: { operation_id: OPERATION_ID, state },
          error: { code, retryable: false },
          result: { stderr: "test failed", exit_code: 1 },
        },
      });
    },
  );

  it("reports a rejected file edit as an error, retaining the durable operation", async () => {
    const base = services();
    const response = await executeWorkspaceTool(
      "workspace_write",
      { workspace_id: WORKSPACE_ID, path: "source.txt", text: "new", expected: { exists: false } },
      USER_ID,
      services({
        file: {
          ...base.file!,
          execute: jest.fn(async () => ({
            operation: { ...operation("write"), state: "failed" },
            result: { action: "write", state: "failed", code: "WORKSPACE_FILE_REJECTED" },
          })),
        },
      }),
    );
    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        operation: { operation_id: OPERATION_ID, state: "failed" },
        error: { code: "WORKSPACE_FILE_REJECTED" },
      },
    });
  });

  it("resumes a download as a native link without requesting the source file again", async () => {
    const base = services();
    const dependencies = services({
      operation: { ...base.operation!, get: jest.fn(() => operation("download")) },
      file: {
        ...base.file!,
        reconcileDownloadReference: jest.fn(async () => ({
          operation: operation("download"),
          transfer: {
            referenceId: `workspace-file://${"x".repeat(43)}`,
            fileName: "result.bin",
            mimeType: "application/octet-stream",
            size: 12,
            sha256: "c".repeat(64),
            expiresAt: 900,
          },
        })),
      },
    });
    const resumed = await executeWorkspaceTool(
      "workspace_download",
      {
        workspace_id: WORKSPACE_ID,
        operation_id: OPERATION_ID,
        file_name: "result.bin",
        mime_type: "application/octet-stream",
      },
      USER_ID,
      dependencies,
    );
    expect(resumed.content).toEqual([
      expect.objectContaining({
        type: "resource_link",
        name: "result.bin",
        size: 12,
      }),
    ]);
    expect(data(resumed)).toMatchObject({ operation: { operation_id: OPERATION_ID } });
    expect(dependencies.file!.downloadReference).not.toHaveBeenCalled();
  });

  it("projects text reads, structured edits, native uploads, and downloads without base64", async () => {
    const execute = jest.fn(
      async (_userId: string, _workspaceId: string, request: { action: string }) => {
        if (request.action === "read") {
          return {
            operation: operation("read"),
            result: {
              action: "read" as const,
              path: "src/index.ts",
              offset: 0,
              totalSize: 5,
              bytes: Buffer.from("hello"),
              sha256: "d".repeat(64),
            },
          };
        }
        if (request.action === "apply_patch") {
          return {
            operation: operation("apply_patch"),
            result: {
              action: "apply_patch" as const,
              files: [
                {
                  path: "src/index.ts",
                  previous: { size: 5, sha256: "d".repeat(64), modifiedAt: 45 },
                  current: { size: 6, sha256: "e".repeat(64), modifiedAt: 46 },
                },
              ],
              summary: {
                filesChanged: 1,
                editsApplied: 1,
                insertedBytes: 6,
                deletedBytes: 5,
                entries: [{ path: "src/index.ts", edits: 1, insertedBytes: 6, deletedBytes: 5 }],
                truncated: false,
              },
            },
          };
        }
        throw new Error("unexpected action");
      },
    );
    const base = services();
    const dependencies = services({ file: { ...base.file!, execute } });
    const read = await executeWorkspaceTool(
      "workspace_read",
      { workspace_id: WORKSPACE_ID, path: "src/index.ts", offset: 0, length: 5 },
      USER_ID,
      dependencies,
    );
    const patched = await executeWorkspaceTool(
      "workspace_apply_patch",
      {
        workspace_id: WORKSPACE_ID,
        files: [
          {
            path: "src/index.ts",
            expected: { exists: true, size_bytes: 5, sha256: "d".repeat(64) },
            edits: [{ start: 0, end: 5, text: "hello!" }],
          },
        ],
      },
      USER_ID,
      dependencies,
    );
    const uploaded = await executeWorkspaceTool(
      "workspace_upload",
      {
        workspace_id: WORKSPACE_ID,
        path: "input.txt",
        file: {
          file_id: "sediment://file_00000000000000000000000000000000",
          download_url: "https://oaiusercontent.com/private-token",
          file_name: "input.txt",
          mime_type: "text/plain",
          size_bytes: 12,
        },
        expected: { exists: false },
      },
      USER_ID,
      dependencies,
    );
    const downloaded = await executeWorkspaceTool(
      "workspace_download",
      {
        workspace_id: WORKSPACE_ID,
        path: "result.txt",
        max_bytes: 1024,
        file_name: "result.txt",
        mime_type: "text/plain",
      },
      USER_ID,
      dependencies,
    );

    expect(data(read)).toMatchObject({ result: { text: "hello", offset: 0, total_size: 5 } });
    expect(data(patched)).toMatchObject({
      result: { summary: { files_changed: 1, edits_applied: 1, truncated: false } },
    });
    expect(JSON.stringify(uploaded)).not.toContain("private-token");
    expect(downloaded.content).toEqual([
      expect.objectContaining({
        type: "resource_link",
        name: "result.txt",
        mimeType: "text/plain",
        size: 12,
      }),
    ]);
    expect(JSON.stringify(downloaded.structuredContent)).not.toContain(
      "/api/workspaces/transfers/",
    );
    expect(JSON.stringify([read, patched, uploaded, downloaded])).not.toMatch(/base64/i);
  });

  it("reports unexpected failures server-side while returning only a generic error", async () => {
    const reported: Array<{ name: string; error: unknown }> = [];
    const restore = setWorkspaceToolFailureReporterForTests((name, error) =>
      reported.push({ name, error }),
    );
    try {
      const statusFailure = new Error("sqlite disk I/O error on /var/lib/moira/private.db");
      const statusBroken = services({
        connection: {
          getStatus: jest.fn(() => {
            throw statusFailure;
          }),
        },
      });
      const projectionFailure = new TypeError("unexpected projection failure");
      const base = services();
      const serviceBroken = services({
        file: {
          ...base.file!,
          execute: jest.fn(async () => {
            throw projectionFailure;
          }),
        },
      });

      const fromStatus = await executeWorkspaceTool("workspace_list", {}, USER_ID, statusBroken);
      const fromService = await executeWorkspaceTool(
        "workspace_write",
        {
          workspace_id: WORKSPACE_ID,
          path: "private/source.ts",
          text: "secret source",
          expected: { exists: false },
        },
        USER_ID,
        serviceBroken,
      );

      for (const result of [fromStatus, fromService]) {
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "INTERNAL_ERROR" } },
        });
        expect(JSON.stringify(result)).not.toMatch(/sqlite|private\.db|projection failure/);
      }
      expect(reported).toEqual([
        { name: "workspace_list", error: statusFailure },
        { name: "workspace_write", error: projectionFailure },
      ]);
    } finally {
      restore();
    }
  });

  it("returns bounded setup, foreign-workspace, and binary-read errors", async () => {
    const disconnected = services({
      connection: {
        getStatus: jest.fn(() => ({
          state: "connection_required" as const,
          reason: "CONNECTION_REQUIRED" as const,
          settingsUrl: "https://moira.example/settings/integrations",
          installationUrl: null,
          account: null,
          installations: [],
          repositories: [],
          canConnect: true,
          canDisconnect: false,
        })),
      },
    });
    const setup = await executeWorkspaceTool(
      "workspace_start",
      { workspace_id: WORKSPACE_ID },
      USER_ID,
      disconnected,
    );

    const foreign = services({
      resource: {
        ...services().resource!,
        getWorkspace: jest.fn(() => {
          throw new WorkspaceResourceError("WORKSPACE_NOT_FOUND", "foreign detail");
        }),
      },
    });
    const missing = await executeWorkspaceTool(
      "workspace_get",
      { workspace_id: WORKSPACE_ID },
      USER_ID,
      foreign,
    );

    const binaryBase = services();
    const binary = services({
      file: {
        ...binaryBase.file!,
        execute: jest.fn(async () => ({
          operation: operation("read"),
          result: {
            action: "read" as const,
            path: "asset.bin",
            offset: 0,
            totalSize: 2,
            bytes: Uint8Array.from([0xff, 0xfe]),
            sha256: "f".repeat(64),
          },
        })),
      },
    });
    const unreadable = await executeWorkspaceTool(
      "workspace_read",
      { workspace_id: WORKSPACE_ID, path: "asset.bin", offset: 0, length: 2 },
      USER_ID,
      binary,
    );

    expect(setup).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "CONNECTION_REQUIRED",
          settings_url: "https://moira.example/settings/integrations",
        },
      },
    });
    expect(missing).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "WORKSPACE_NOT_FOUND" } },
    });
    expect(JSON.stringify(missing)).not.toContain("foreign detail");
    expect(unreadable).toMatchObject({
      isError: true,
      structuredContent: {
        operation: { operation_id: OPERATION_ID, state: "succeeded" },
        error: { code: "WORKSPACE_BINARY_READ_REQUIRES_DOWNLOAD" },
      },
    });
  });
});
