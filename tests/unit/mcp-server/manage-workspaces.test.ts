import { describe, expect, it, jest } from "@jest/globals";
import { z } from "zod";
import {
  WorkspaceResourceError,
  type WorkspaceOperationRecord,
  type WorkspaceOperationResult,
  type WorkspaceResourceRecord,
} from "@mcp-moira/shared";

import {
  executeWorkspaceTool,
  manageWorkspaceTool,
  parseWorkspaceToolParams,
  setWorkspaceToolFailureReporterForTests,
  setWorkspaceToolServicesLoaderForTests,
  workspaceToolLogContext,
  WorkspaceRequestInvalidError,
  type WorkspaceToolServices,
} from "../../../packages/mcp-server/src/tools/manage-workspaces.js";
import {
  WORKSPACE_ACTION_REQUEST_SCHEMAS,
  workspaceSchema,
} from "../../../packages/mcp-server/src/tools/tool-schemas.js";
import { requestContext } from "../../../packages/mcp-server/src/core/request-context.js";

const USER_ID = "user-a";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000003";

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
      readOutput: jest.fn(async () => ({
        stream: "stdout" as const,
        offset: 4,
        totalBytes: 12,
        bytes: Buffer.from("retained"),
      })),
      execute: jest.fn(async () => ({
        operation: operation("exec"),
        result: execResult({
          state: "succeeded" as const,
          stdout: "ok\n",
          stderr: "",
          exitCode: 0,
        }),
      })),
      executeNativeReference: jest.fn(async () => ({
        operation: operation("exec"),
        result: execResult({
          state: "succeeded" as const,
          stdout: "native\n",
          stderr: "",
          exitCode: 0,
        }),
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

/** A terminal exec result as the service reports it, payload plus complete retained sizes. */
function execResult(
  value: Pick<WorkspaceOperationResult, "state" | "stdout" | "stderr" | "exitCode"> &
    Partial<WorkspaceOperationResult>,
): WorkspaceOperationResult {
  return {
    ...value,
    stdoutTotalBytes: value.stdoutTotalBytes ?? Buffer.byteLength(value.stdout),
    stderrTotalBytes: value.stderrTotalBytes ?? Buffer.byteLength(value.stderr),
    outputLimitExceeded: value.outputLimitExceeded ?? false,
    sessionCaptureDropped: value.sessionCaptureDropped ?? false,
  };
}

function data(result: Awaited<ReturnType<typeof executeWorkspaceTool>>) {
  return result.structuredContent as Record<string, unknown>;
}

describe("workspace MCP adapter", () => {
  it.each(["private-token", "x".repeat(10000), `${WORKSPACE_ID}\nprivate-source`, 42, null])(
    "omits malformed identifiers from pre-validation logging (%#)",
    (identifier) => {
      expect(
        workspaceToolLogContext({
          action: "exec",
          workspace_id: identifier,
          operation_id: identifier,
        }),
      ).toEqual({ inputData: { workspace_action: "exec" }, resourceIds: {} });
    },
  );

  it("logs only opaque workspace/operation identity and never workspace input", () => {
    const projected = workspaceToolLogContext({
      action: "upload",
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
      inputData: { workspace_action: "upload" },
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
    const listed = await executeWorkspaceTool(
      parseWorkspaceToolParams({ action: "list" }),
      USER_ID,
      dependencies,
    );
    const fetched = await executeWorkspaceTool(
      parseWorkspaceToolParams({ action: "get", workspace_id: WORKSPACE_ID }),
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
      parseWorkspaceToolParams({ action: "create", repository_id: "42", ref: "main" }),
      USER_ID,
      dependencies,
    );
    const stopped = await executeWorkspaceTool(
      parseWorkspaceToolParams({ action: "stop", workspace_id: WORKSPACE_ID }),
      USER_ID,
      dependencies,
    );
    const deleted = await executeWorkspaceTool(
      parseWorkspaceToolParams({
        action: "delete",
        workspace_id: WORKSPACE_ID,
        expected_generation: 4,
        confirm_delete: true,
      }),
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
      parseWorkspaceToolParams({
        action: "exec",
        workspace_id: WORKSPACE_ID,
        argv: ["node", "script.js"],
        cwd: ".",
        timeout_seconds: 30,
        stdin_text: "hello",
      }),
      USER_ID,
      dependencies,
    );
    const native = await executeWorkspaceTool(
      parseWorkspaceToolParams({
        action: "exec",
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
      }),
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
    const execute = jest.fn<NonNullable<WorkspaceToolServices["operation"]>["execute"]>();
    const reconcile = jest.fn<NonNullable<WorkspaceToolServices["operation"]>["reconcile"]>(
      async () => {
        current = { ...operation("exec"), state: "succeeded" as const };
        return execResult({
          state: "succeeded" as const,
          stdout: "recovered\n",
          stderr: "",
          exitCode: 0,
        });
      },
    );
    const base = services();
    const dependencies = services({
      operation: {
        ...base.operation!,
        get: jest.fn<NonNullable<WorkspaceToolServices["operation"]>["get"]>(() => current),
        reconcile,
        execute,
      },
    });

    const resumed = await executeWorkspaceTool(
      parseWorkspaceToolParams({
        action: "exec",
        workspace_id: WORKSPACE_ID,
        operation_id: OPERATION_ID,
      }),
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
        parseWorkspaceToolParams({
          action: "exec",
          workspace_id: WORKSPACE_ID,
          argv: ["node", "test.js"],
          cwd: ".",
          timeout_seconds: 30,
        }),
        USER_ID,
        services({
          operation: {
            ...base.operation!,
            execute: jest.fn(async () => ({
              operation: { ...operation("exec"), state, exitCode: 1 },
              result: execResult({ state, stdout: "", stderr: "test failed", exitCode: 1 }),
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

  it("tells a command lost to a workspace restart apart from one that failed on its own", async () => {
    let current: WorkspaceOperationRecord = { ...operation("exec"), state: "running" };
    const base = services();
    const response = await executeWorkspaceTool(
      parseWorkspaceToolParams({
        action: "exec",
        workspace_id: WORKSPACE_ID,
        operation_id: OPERATION_ID,
      }),
      USER_ID,
      services({
        operation: {
          ...base.operation!,
          get: jest.fn<NonNullable<WorkspaceToolServices["operation"]>["get"]>(() => current),
          reconcile: jest.fn(async () => {
            current = {
              ...operation("exec"),
              state: "failed" as const,
              exitCode: null,
              lastOutcome: "workspace_restarted",
            };
            return execResult({ state: "failed", stdout: "", stderr: "", exitCode: null });
          }),
        },
      }),
    );

    // The required state: the agent can branch on a restart. The wrong state that looks the same is
    // an ordinary failure with empty output, which is what a caller saw before and what would point
    // it at output that never existed.
    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        operation: { operation_id: OPERATION_ID, state: "failed", interrupted_by_restart: true },
        error: { code: "WORKSPACE_OPERATION_INTERRUPTED", retryable: false },
      },
    });
    expect(JSON.stringify(data(response))).toContain("restarted");
  });

  it("reports a rejected file edit as an error, retaining the durable operation", async () => {
    const base = services();
    const response = await executeWorkspaceTool(
      parseWorkspaceToolParams({
        action: "write",
        workspace_id: WORKSPACE_ID,
        path: "source.txt",
        text: "new",
        expected: { exists: false },
      }),
      USER_ID,
      services({
        file: {
          ...base.file!,
          execute: jest.fn<NonNullable<WorkspaceToolServices["file"]>["execute"]>(async () => ({
            operation: { ...operation("write"), state: "failed" as const },
            result: {
              action: "write" as const,
              state: "failed" as const,
              code: "WORKSPACE_FILE_REJECTED",
            },
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
      parseWorkspaceToolParams({
        action: "download",
        workspace_id: WORKSPACE_ID,
        operation_id: OPERATION_ID,
        file_name: "result.bin",
        mime_type: "application/octet-stream",
      }),
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
      parseWorkspaceToolParams({
        action: "read",
        workspace_id: WORKSPACE_ID,
        path: "src/index.ts",
        offset: 0,
        length: 5,
      }),
      USER_ID,
      dependencies,
    );
    const patched = await executeWorkspaceTool(
      parseWorkspaceToolParams({
        action: "apply_patch",
        workspace_id: WORKSPACE_ID,
        files: [
          {
            path: "src/index.ts",
            expected: { exists: true, size_bytes: 5, sha256: "d".repeat(64) },
            edits: [{ start: 0, end: 5, text: "hello!" }],
          },
        ],
      }),
      USER_ID,
      dependencies,
    );
    const uploaded = await executeWorkspaceTool(
      parseWorkspaceToolParams({
        action: "upload",
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
      }),
      USER_ID,
      dependencies,
    );
    const downloaded = await executeWorkspaceTool(
      parseWorkspaceToolParams({
        action: "download",
        workspace_id: WORKSPACE_ID,
        path: "result.txt",
        max_bytes: 1024,
        file_name: "result.txt",
        mime_type: "text/plain",
      }),
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

      const fromStatus = await executeWorkspaceTool(
        parseWorkspaceToolParams({ action: "list" }),
        USER_ID,
        statusBroken,
      );
      const fromService = await executeWorkspaceTool(
        parseWorkspaceToolParams({
          action: "write",
          workspace_id: WORKSPACE_ID,
          path: "private/source.ts",
          text: "secret source",
          expected: { exists: false },
        }),
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
        { name: "list", error: statusFailure },
        { name: "write", error: projectionFailure },
      ]);
    } finally {
      restore();
    }
  });

  it("carries a truncated payload's complete size and reads a retained range without dispatching", async () => {
    const base = services();
    const noisy = services({
      operation: {
        ...base.operation!,
        execute: jest.fn(async () => ({
          operation: { ...operation("exec"), state: "failed" as const, exitCode: 7 },
          result: execResult({
            state: "failed" as const,
            stdout: "first bytes",
            stderr: "real failure",
            exitCode: 7,
            stdoutTotalBytes: 900_000,
          }),
        })),
      },
    });
    const executed = await executeWorkspaceTool(
      parseWorkspaceToolParams({
        action: "exec",
        workspace_id: WORKSPACE_ID,
        argv: ["build"],
        cwd: ".",
        timeout_seconds: 60,
      }),
      USER_ID,
      noisy,
    );
    // The command's own exit code and standard error survive; the payload says what it omitted.
    expect(data(executed).result).toMatchObject({
      exit_code: 7,
      stderr: "real failure",
      stdout_total_bytes: 900_000,
      stdout_truncated: true,
      stderr_truncated: false,
      output_limit_exceeded: false,
    });

    const owning = services({
      operation: { ...base.operation!, get: jest.fn(() => operation("exec")) },
    });
    const ranged = await executeWorkspaceTool(
      // Parsed the way the transport parses it, so the published range default is exercised.
      parseWorkspaceToolParams({
        action: "read",
        workspace_id: WORKSPACE_ID,
        operation_id: OPERATION_ID,
        stream: "stdout",
        offset: 4,
      }),
      USER_ID,
      owning,
    );
    expect(data(ranged)).toEqual({
      output: {
        operation_id: OPERATION_ID,
        stream: "stdout",
        offset: 4,
        total_bytes: 12,
        text: "retained",
        truncated: false,
      },
    });
    expect(owning.operation!.readOutput).toHaveBeenCalledWith(USER_ID, OPERATION_ID, {
      stream: "stdout",
      offset: 4,
      length: 64 * 1024,
    });

    // Naming a workspace the command does not belong to is refused, not silently answered.
    const foreignWorkspace = services({
      operation: {
        ...base.operation!,
        get: jest.fn(() => ({ ...operation("exec"), resourceId: OTHER_WORKSPACE_ID })),
        readOutput: jest.fn(async () => {
          throw new Error("a mismatched workspace must be refused before the service is reached");
        }),
      },
    });
    const mismatched = await executeWorkspaceTool(
      parseWorkspaceToolParams({
        action: "read",
        workspace_id: WORKSPACE_ID,
        operation_id: OPERATION_ID,
        stream: "stdout",
      }),
      USER_ID,
      foreignWorkspace,
    );
    expect((data(mismatched) as { error: { code: string } }).error.code).toBe(
      "WORKSPACE_NOT_FOUND",
    );
    expect(foreignWorkspace.operation!.readOutput).not.toHaveBeenCalled();
    // Reading retained output is not a file operation and dispatches none.
    expect(owning.file!.execute).not.toHaveBeenCalled();

    const stopped = services({
      operation: {
        ...base.operation!,
        execute: jest.fn(async () => ({
          operation: { ...operation("exec"), state: "failed" as const, exitCode: null },
          result: execResult({
            state: "failed" as const,
            stdout: "partial",
            stderr: "",
            exitCode: null,
            stdoutTotalBytes: 64 * 1024 * 1024,
            outputLimitExceeded: true,
          }),
        })),
      },
    });
    const halted = await executeWorkspaceTool(
      parseWorkspaceToolParams({
        action: "exec",
        workspace_id: WORKSPACE_ID,
        argv: ["flood"],
        cwd: ".",
        timeout_seconds: 60,
      }),
      USER_ID,
      stopped,
    );
    // A command stopped by the retained ceiling says so instead of reading as its own failure.
    expect((data(halted) as { error: { code: string } }).error.code).toBe(
      "WORKSPACE_OPERATION_OUTPUT_LIMIT",
    );
  });

  it("passes a session through and never echoes what it stores", async () => {
    const base = services();
    const executed = await executeWorkspaceTool(
      parseWorkspaceToolParams({
        action: "exec",
        workspace_id: WORKSPACE_ID,
        argv: ["npm", "run", "build"],
        session: "build",
        session_start: true,
        cwd: "service",
        env: { BUILD_TARGET: "release" },
      }),
      USER_ID,
      base,
    );
    expect(base.operation!.execute).toHaveBeenCalledWith(
      USER_ID,
      WORKSPACE_ID,
      expect.objectContaining({
        session: "build",
        sessionStart: true,
        cwd: "service",
        env: { BUILD_TARGET: "release" },
      }),
    );
    // A session's variables are the caller's own secret material; no result carries them back.
    expect(JSON.stringify(data(executed))).not.toContain("BUILD_TARGET");
    expect(JSON.stringify(data(executed))).not.toContain("release");
  });

  it("hands the caller the provider's own reason for a refused creation", async () => {
    // The end of the path #219 is about: the provider named a constraint, the client redacted and
    // bounded it, the service raised it as the refusal's detail, and the agent that asked for the
    // workspace can read it here instead of being told only that creation was rejected.
    const base = services();
    const refusing = services({
      resource: {
        ...base.resource!,
        create: jest.fn(async () => {
          throw new WorkspaceResourceError(
            "WORKSPACE_CREATE_REJECTED",
            "Workspace creation was rejected",
            "retention_period_minutes exceeds the maximum for this owner",
          );
        }),
      },
    });

    const refused = await executeWorkspaceTool(
      parseWorkspaceToolParams({ action: "create", repository_id: "42", ref: "main" }),
      USER_ID,
      refusing,
    );

    const error = (
      data(refused) as { error: { code: string; message: string; retryable: boolean } }
    ).error;
    expect(error.code).toBe("WORKSPACE_CREATE_REJECTED");
    expect(error.message).toContain("retention_period_minutes exceeds the maximum for this owner");
    // A refusal the provider will repeat is not something to retry.
    expect(error.retryable).toBe(false);
  });

  it("tells a refused caller which ceiling stopped it and stays generic without a detail", async () => {
    const base = services();
    const named = services({
      resource: {
        ...base.resource!,
        create: jest.fn(async () => {
          throw new WorkspaceResourceError(
            "WORKSPACE_POLICY_LIMIT",
            "Workspace per-user concurrency limit reached",
            "You already hold 4 active workspaces, which is the per-user ceiling.",
          );
        }),
      },
    });
    const refused = await executeWorkspaceTool(
      parseWorkspaceToolParams({ action: "create", repository_id: "42", ref: "main" }),
      USER_ID,
      named,
    );
    const refusedError = (data(refused) as { error: { code: string; message: string } }).error;
    expect(refusedError.code).toBe("WORKSPACE_POLICY_LIMIT");
    expect(refusedError.message).toContain("per-user ceiling");

    const unnamed = services({
      resource: {
        ...base.resource!,
        create: jest.fn(async () => {
          throw new WorkspaceResourceError("WORKSPACE_POLICY_LIMIT", "operator-only sentence");
        }),
      },
    });
    const generic = await executeWorkspaceTool(
      parseWorkspaceToolParams({ action: "create", repository_id: "42", ref: "main" }),
      USER_ID,
      unnamed,
    );
    const genericError = (data(generic) as { error: { message: string } }).error;
    expect(genericError.message).not.toContain("operator-only sentence");
    expect(genericError.message).toBe(
      "A workspace quota, concurrency, size or time limit was reached.",
    );
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
      parseWorkspaceToolParams({ action: "start", workspace_id: WORKSPACE_ID }),
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
      parseWorkspaceToolParams({ action: "get", workspace_id: WORKSPACE_ID }),
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
      parseWorkspaceToolParams({
        action: "read",
        workspace_id: WORKSPACE_ID,
        path: "asset.bin",
        offset: 0,
        length: 2,
      }),
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

  it("fills published defaults so a minimal call is a complete strict request", () => {
    // The parsed call carries the action that selected the contract beside the request it accepted.
    expect(
      parseWorkspaceToolParams({ action: "read", workspace_id: WORKSPACE_ID, path: "a" }),
    ).toEqual({
      action: "read",
      request: { workspace_id: WORKSPACE_ID, path: "a", offset: 0, length: 64 * 1024 },
    });
    expect(
      parseWorkspaceToolParams({
        action: "search",
        workspace_id: WORKSPACE_ID,
        path: ".",
        query: "TODO",
      }),
    ).toEqual({
      action: "search",
      request: {
        workspace_id: WORKSPACE_ID,
        path: ".",
        query: "TODO",
        mode: "literal",
        max_matches: 100,
        max_bytes: 64 * 1024,
      },
    });
    expect(
      parseWorkspaceToolParams({ action: "exec", workspace_id: WORKSPACE_ID, argv: ["ls"] }),
      // A bounded command names no duration: the service applies the default its mode implies.
    ).toEqual({
      action: "exec",
      request: {
        workspace_id: WORKSPACE_ID,
        argv: ["ls"],
        background: false,
        session_start: false,
        session_end: false,
      },
    });
    expect(
      parseWorkspaceToolParams({
        action: "download",
        workspace_id: WORKSPACE_ID,
        path: "dist/app.zip",
        file_name: "app.zip",
        mime_type: "application/zip",
      }),
    ).toMatchObject({ action: "download", request: { max_bytes: 4 * 1024 * 1024 } });
  });

  it("names the missing or invalid fields of an incomplete request instead of a generic error", async () => {
    expect(() =>
      parseWorkspaceToolParams({ action: "search", workspace_id: WORKSPACE_ID, path: "." }),
    ).toThrow(WorkspaceRequestInvalidError);
    let detail = "";
    try {
      parseWorkspaceToolParams({
        action: "write",
        workspace_id: WORKSPACE_ID,
        path: "src/index.ts",
        text: "print('a secret value')",
      });
    } catch (error) {
      detail = (error as WorkspaceRequestInvalidError).detail;
    }
    expect(detail).toBe("expected: Required");

    const restoreLoader = setWorkspaceToolServicesLoaderForTests(async () => services());
    try {
      const result = await requestContext.run({ userId: USER_ID }, () =>
        manageWorkspaceTool({
          action: "read",
          workspace_id: WORKSPACE_ID,
          path: "README.md",
          length: "all of it",
        }),
      );
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "WORKSPACE_REQUEST_INVALID",
            retryable: false,
            message: expect.stringContaining("length: Expected number, received string"),
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain("all of it");
    } finally {
      restoreLoader();
    }
  });

  // One published object carries every action's fields, so the only thing standing between a caller
  // and a request shaped for a different action is this check. Each row sends one action a field
  // that belongs to another and asserts the refusal's identity: "an error happened" is also true of
  // an implementation that accepted the field and failed later for some other reason.
  it.each([
    ["list", { workspace_id: WORKSPACE_ID }],
    ["create", { repository_id: "42", ref: "main", workspace_id: WORKSPACE_ID }],
    ["get", { workspace_id: WORKSPACE_ID, path: "README.md" }],
    ["start", { workspace_id: WORKSPACE_ID, argv: ["ls"] }],
    ["stop", { workspace_id: WORKSPACE_ID, confirm_delete: true }],
    [
      "delete",
      {
        workspace_id: WORKSPACE_ID,
        expected_generation: 3,
        confirm_delete: true,
        query: "TODO",
      },
    ],
    ["exec", { workspace_id: WORKSPACE_ID, argv: ["ls"], path: "README.md" }],
    ["stat", { workspace_id: WORKSPACE_ID, path: "README.md", argv: ["ls"] }],
    ["search", { workspace_id: WORKSPACE_ID, path: ".", query: "TODO", text: "x" }],
    ["read", { workspace_id: WORKSPACE_ID, path: "README.md", query: "TODO" }],
    [
      "write",
      {
        workspace_id: WORKSPACE_ID,
        path: "a.txt",
        text: "x",
        expected: { exists: false },
        cwd: ".",
      },
    ],
    [
      "apply_patch",
      {
        workspace_id: WORKSPACE_ID,
        files: [
          { path: "a.txt", expected: { exists: true }, edits: [{ start: 0, end: 1, text: "y" }] },
        ],
        text: "x",
      },
    ],
    [
      "upload",
      {
        workspace_id: WORKSPACE_ID,
        path: "a.txt",
        expected: { exists: false },
        file: {
          file_id: "sediment://file_00000000000000000000000000000000",
          download_url: "https://oaiusercontent.com/example",
        },
        max_bytes: 1024,
      },
    ],
    [
      "download",
      {
        workspace_id: WORKSPACE_ID,
        path: "a.bin",
        file_name: "a.bin",
        mime_type: "application/octet-stream",
        query: "TODO",
      },
    ],
  ])("refuses action %s a field that belongs to another action", (action, request) => {
    expect(() => parseWorkspaceToolParams({ action, ...request })).toThrow(
      WorkspaceRequestInvalidError,
    );
  });

  // The mirror of the rows above: those prove the published object accepts too much and dispatch
  // refuses the excess. These prove it does not accept too little — a collapse that narrowed one
  // action's field while merging it would pass every foreign-argument row and fail here. Each
  // payload carries that action's boundary values, so a bound lost in the projection is visible.
  it.each([
    ["list", {}],
    ["create", { repository_id: "42", ref: "main" }],
    ["get", { workspace_id: WORKSPACE_ID }],
    ["start", { workspace_id: WORKSPACE_ID }],
    ["stop", { workspace_id: WORKSPACE_ID }],
    ["delete", { workspace_id: WORKSPACE_ID, expected_generation: 3, confirm_delete: true }],
    [
      "exec",
      {
        workspace_id: WORKSPACE_ID,
        argv: ["node", "script.js"],
        cwd: "packages",
        env: { PATH_EXTRA: "x" },
        session: "build",
        session_start: true,
        session_end: false,
        background: true,
        timeout_seconds: 24 * 60 * 60,
        max_stdout_bytes: 8 * 1024 * 1024,
        max_stderr_bytes: 8 * 1024 * 1024,
        stdin_text: "input",
      },
    ],
    ["stat", { workspace_id: WORKSPACE_ID, path: "package.json" }],
    [
      "search",
      {
        workspace_id: WORKSPACE_ID,
        path: ".",
        query: "TODO",
        mode: "regex",
        max_matches: 1000,
        max_bytes: 1024 * 1024,
      },
    ],
    ["read", { workspace_id: WORKSPACE_ID, path: "a.txt", offset: 0, length: 4 * 1024 * 1024 }],
    [
      "read",
      { workspace_id: WORKSPACE_ID, operation_id: OPERATION_ID, stream: "stderr", length: 1 },
    ],
    [
      "write",
      {
        workspace_id: WORKSPACE_ID,
        path: "a.txt",
        text: "x",
        expected: { exists: true, size_bytes: 1, sha256: "a".repeat(64) },
      },
    ],
    [
      "apply_patch",
      {
        workspace_id: WORKSPACE_ID,
        files: [
          {
            path: "a.txt",
            expected: { exists: true },
            edits: [{ start: 0, end: 1, text: "y" }],
          },
        ],
      },
    ],
    [
      "upload",
      {
        workspace_id: WORKSPACE_ID,
        path: "a.txt",
        expected: { exists: false },
        file: {
          file_id: "sediment://file_00000000000000000000000000000000",
          download_url: "https://oaiusercontent.com/example",
          file_name: "a.txt",
          mime_type: "text/plain",
          size_bytes: 1,
        },
      },
    ],
    [
      // `download` and `search` both declare `max_bytes` with different ceilings; the published
      // object must still accept a download at its own 4 MiB bound.
      "download",
      {
        workspace_id: WORKSPACE_ID,
        path: "a.bin",
        file_name: "a.bin",
        mime_type: "application/octet-stream",
        max_bytes: 4 * 1024 * 1024,
      },
    ],
    [
      "download",
      {
        workspace_id: WORKSPACE_ID,
        operation_id: OPERATION_ID,
        file_name: "a.bin",
        mime_type: "application/octet-stream",
      },
    ],
  ])("publishes a payload action %s accepts", (action, request) => {
    const payload = { action, ...request };
    expect(workspaceSchema.safeParse(payload).success).toBe(true);
    expect(() => parseWorkspaceToolParams(payload)).not.toThrow();
  });

  it("refuses an unknown action and a field belonging to no action at all", async () => {
    // An action nobody serves is refused before any contract is chosen for it.
    expect(() => parseWorkspaceToolParams({ action: "teleport" })).toThrow(
      WorkspaceRequestInvalidError,
    );
    expect(() => parseWorkspaceToolParams({ workspace_id: WORKSPACE_ID })).toThrow(
      WorkspaceRequestInvalidError,
    );
    // A field no action declares never reaches dispatch: the published object is still strict.
    expect(workspaceSchema.safeParse({ action: "list", chat_id: "c1" }).success).toBe(false);
    // Every action the tool dispatches is an action the published object offers, so none of them is
    // unreachable through the catalog.
    expect(
      [...((workspaceSchema.shape.action as z.ZodEnum<[string, ...string[]]>).options as string[])]
        .sort()
        .join(","),
    ).toBe(Object.keys(WORKSPACE_ACTION_REQUEST_SCHEMAS).sort().join(","));
  });
});
