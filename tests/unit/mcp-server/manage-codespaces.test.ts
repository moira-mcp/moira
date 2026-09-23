import { describe, expect, it, jest } from "@jest/globals";
import { z } from "zod";
import {
  CodespaceConnectionError,
  CodespaceResourceError,
  evaluateCodespaceResourcePolicy,
  projectCodespaceLimits,
  type CodespaceGuidanceSituation,
  type CodespaceOperationRecord,
  type CodespaceOperationResult,
  type CodespaceResourceRecord,
} from "@mcp-moira/shared";

import {
  executeCodespaceTool,
  manageCodespaceTool,
  parseCodespaceToolParams,
  setCodespaceToolFailureReporterForTests,
  setCodespaceToolServicesLoaderForTests,
  codespaceToolLogContext,
  CodespaceRequestInvalidError,
  type CodespaceToolServices,
} from "../../../packages/mcp-server/src/tools/manage-codespaces.js";
import {
  CODESPACE_ACTION_REQUEST_SCHEMAS,
  codespaceSchema,
} from "../../../packages/mcp-server/src/tools/tool-schemas.js";
import { requestContext } from "../../../packages/mcp-server/src/core/request-context.js";

const USER_ID = "user-a";
const CODESPACE_ID = "00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_CODESPACE_ID = "00000000-0000-4000-8000-000000000003";

function codespace(overrides: Partial<CodespaceResourceRecord> = {}): CodespaceResourceRecord {
  return {
    id: CODESPACE_ID,
    userId: USER_ID,
    connectionId: "secret-connection",
    authorizationGeneration: 7,
    provider: "github-codespaces",
    repositoryId: "42",
    repositoryFullName: "owner/repository",
    requestedRef: "main",
    observedRef: "feature/current",
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
    reconcileFailures: 0,
    lastActivityAt: null,
    providerLastUsedAt: null,
    lastOutcome: "verified_usable",
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function operation(
  kind: "exec" | "stat" | "search" | "read" | "write" | "apply_patch" | "upload" | "download",
): CodespaceOperationRecord {
  return {
    id: OPERATION_ID,
    userId: USER_ID,
    resourceId: CODESPACE_ID,
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

/** A user's limits as the domain computes them, from the shipped policy and some use. */
const LIMITS = projectCodespaceLimits({
  policy: evaluateCodespaceResourcePolicy(() => undefined),
  held: 2,
  instanceHeld: 5,
  activeOperations: 1,
  transfers: { objects: 1, bytes: 2048, inflightBytes: 1024 },
  idle: { autoStopEnabled: true, idleTimeoutMinutes: 30 },
  providerIdleMaxMinutes: 240,
});

function services(overrides: Partial<CodespaceToolServices> = {}): CodespaceToolServices {
  return {
    observability: {
      limits: jest.fn(() => LIMITS),
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
          max_transfer_live_bytes: 1024 ** 3,
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
      refreshGrants: jest.fn(async () => ({ refreshed: false, stale: false })),
    },
    guidance: (situation: CodespaceGuidanceSituation) => ({
      provider: "github-codespaces",
      situation,
      instruction: `do this for ${situation}`,
      links: [
        { id: "settings", url: "https://moira.example/settings", label: "Moira settings" },
        { id: "install", url: "https://github.test/install", label: "Install the app" },
        {
          id: "create_repository",
          url: "https://github.test/new",
          label: "New repository",
        },
      ],
    }),
    resource: {
      listRepositories: jest.fn(() => [{ id: "42", fullName: "owner/repository", private: true }]),
      setupSituation: jest.fn(() => "ready" as const),
      listResources: jest.fn(() => [codespace()]),
      getCodespace: jest.fn(() => codespace()),
      create: jest.fn(async () => ({
        resource: codespace(),
        lifecycleCapability: "secret-capability",
      })),
      startCodespace: jest.fn(async () => codespace()),
      stopCodespace: jest.fn(async () =>
        codespace({
          state: "stopped",
          desiredState: "stopped",
          observedState: "stopped",
          generation: 4,
        }),
      ),
      deleteCodespace: jest.fn(async () =>
        codespace({
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
          referenceId: `codespace-file://${"x".repeat(43)}`,
          fileName: "result.txt",
          mimeType: "text/plain",
          size: 12,
          sha256: "c".repeat(64),
          expiresAt: 900,
        },
      })),
    },
    ...overrides,
  } as unknown as CodespaceToolServices;
}

/** A terminal exec result as the service reports it, payload plus complete retained sizes. */
function execResult(
  value: Pick<CodespaceOperationResult, "state" | "stdout" | "stderr" | "exitCode"> &
    Partial<CodespaceOperationResult>,
): CodespaceOperationResult {
  return {
    ...value,
    stdoutTotalBytes: value.stdoutTotalBytes ?? Buffer.byteLength(value.stdout),
    stderrTotalBytes: value.stderrTotalBytes ?? Buffer.byteLength(value.stderr),
    outputLimitExceeded: value.outputLimitExceeded ?? false,
    sessionCaptureDropped: value.sessionCaptureDropped ?? false,
  };
}

function data(result: Awaited<ReturnType<typeof executeCodespaceTool>>) {
  return result.structuredContent as Record<string, unknown>;
}

describe("codespace MCP adapter", () => {
  it.each(["private-token", "x".repeat(10000), `${CODESPACE_ID}\nprivate-source`, 42, null])(
    "omits malformed identifiers from pre-validation logging (%#)",
    (identifier) => {
      expect(
        codespaceToolLogContext({
          action: "exec",
          codespace_id: identifier,
          operation_id: identifier,
        }),
      ).toEqual({ inputData: { codespace_action: "exec" }, resourceIds: {} });
    },
  );

  it("logs only opaque codespace/operation identity and never codespace input", () => {
    const projected = codespaceToolLogContext({
      action: "upload",
      codespace_id: CODESPACE_ID,
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
      inputData: { codespace_action: "upload" },
      resourceIds: { codespaceId: CODESPACE_ID, operationId: OPERATION_ID },
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /secret query|secret source|print-secret|private-token|private\.txt|sediment/,
    );
  });

  it("lists and gets reusable codespace state without internal authority fields", async () => {
    const dependencies = services();
    dependencies.resource!.getCodespace = jest.fn(() =>
      codespace({ lastOutcome: "provider-private-diagnostic" }),
    );
    const listed = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "list" }),
      USER_ID,
      dependencies,
    );
    const fetched = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "get", codespace_id: CODESPACE_ID }),
      USER_ID,
      dependencies,
    );

    expect(data(listed)).toMatchObject({
      readiness: { state: "connected" },
      instance: { state: "ready", provider: "github-codespaces", connector: "available" },
      repositories: [{ repository_id: "42", name: "owner/repository", private: true }],
      codespaces: [{ codespace_id: CODESPACE_ID, generation: 3 }],
      // The caller's own limits, as the domain computed them for this caller.
      limits: LIMITS,
    });
    expect(dependencies.observability.limits).toHaveBeenCalledWith(USER_ID);
    // The branch an agent switched to is reported next to, not instead of, the one it asked for.
    expect(data(fetched)).toMatchObject({
      codespace: {
        codespace_id: CODESPACE_ID,
        requested_ref: "main",
        current_ref: "feature/current",
      },
    });
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

  it("refreshes grants before projecting list status and marks provider fallback as stale", async () => {
    const dependencies = services();
    const getStatus = jest
      .fn<CodespaceToolServices["connection"]["getStatus"]>()
      .mockReturnValueOnce({
        state: "installation_required" as const,
        reason: "INSTALLATION_REQUIRED" as const,
        settingsUrl: "https://moira.example/settings",
        installationUrl: "https://github.test/install",
        account: null,
        installations: [],
        repositories: [],
        canConnect: false,
        canDisconnect: true,
      })
      .mockReturnValue({
        state: "connected" as const,
        reason: null,
        settingsUrl: "https://moira.example/settings",
        installationUrl: null,
        account: null,
        installations: [],
        repositories: [],
        canConnect: false,
        canDisconnect: true,
      });
    dependencies.connection = {
      getStatus,
      refreshGrants: jest.fn(async () => ({ refreshed: false, stale: true })),
    };

    const listed = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "list", refresh: true }),
      USER_ID,
      dependencies,
    );
    expect(dependencies.connection.refreshGrants).toHaveBeenCalledWith(USER_ID, { force: true });
    expect(data(listed)).toMatchObject({
      readiness: { state: "connected", reason: null },
      repositories_stale: true,
    });
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("returns provider-owned setup instructions and exact links for the current missing condition", async () => {
    const dependencies = services();
    dependencies.resource!.setupSituation = jest.fn(
      (): CodespaceGuidanceSituation => "repository_not_approved",
    );
    const helped = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "setup_help", repository_id: "missing-repository" }),
      USER_ID,
      dependencies,
    );

    expect(dependencies.resource!.setupSituation).toHaveBeenCalledWith(
      USER_ID,
      "missing-repository",
    );
    expect(dependencies.connection.refreshGrants).toHaveBeenCalledWith(USER_ID);
    expect(data(helped)).toEqual({
      situation: "repository_not_approved",
      provider: "github-codespaces",
      reason: null,
      instruction: "do this for repository_not_approved",
      repositories_stale: false,
      links: [
        { id: "settings", url: "https://moira.example/settings", label: "Moira settings" },
        { id: "install", url: "https://github.test/install", label: "Install the app" },
        {
          id: "create_repository",
          url: "https://github.test/new",
          label: "New repository",
        },
      ],
    });
  });

  it("keeps provider guidance available when runtime codespace services are not configured", async () => {
    const dependencies = services({ resource: null, operation: null, file: null });
    const helped = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "setup_help" }),
      USER_ID,
      dependencies,
    );
    expect(data(helped)).toMatchObject({
      situation: "not_configured",
      provider: "github-codespaces",
      instruction: "do this for not_configured",
      links: expect.arrayContaining([
        expect.objectContaining({ id: "settings", url: "https://moira.example/settings" }),
        expect.objectContaining({ id: "create_repository", url: "https://github.test/new" }),
      ]),
    });
  });

  it("keeps creation capability private and distinguishes stop from confirmed delete", async () => {
    const dependencies = services();
    const created = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "create", repository_id: "42", ref: "main" }),
      USER_ID,
      dependencies,
    );
    const stopped = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "stop", codespace_id: CODESPACE_ID }),
      USER_ID,
      dependencies,
    );
    const deleted = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "delete",
        codespace_id: CODESPACE_ID,
        expected_generation: 4,
        confirm_delete: true,
      }),
      USER_ID,
      dependencies,
    );

    expect(JSON.stringify(created)).not.toContain("secret-capability");
    expect(dependencies.connection.refreshGrants).toHaveBeenCalledWith(USER_ID);
    expect(data(stopped)).toMatchObject({ data_preserved: true });
    expect(data(deleted)).toMatchObject({ data_preserved: false });
    expect(dependencies.resource?.deleteCodespace).toHaveBeenCalledWith(USER_ID, CODESPACE_ID, 4);
  });

  it("uses exactly one inline or native stdin path without returning the native reference", async () => {
    const dependencies = services();
    await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "exec",
        codespace_id: CODESPACE_ID,
        argv: ["node", "script.js"],
        cwd: ".",
        timeout_seconds: 30,
        stdin_text: "hello",
      }),
      USER_ID,
      dependencies,
    );
    const native = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "exec",
        codespace_id: CODESPACE_ID,
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
      CODESPACE_ID,
      expect.objectContaining({
        stdin: { kind: "inline", bytes: Buffer.from("hello") },
      }),
    );
    expect(dependencies.operation?.executeNativeReference).toHaveBeenCalledWith(
      USER_ID,
      CODESPACE_ID,
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
    let current: CodespaceOperationRecord = { ...operation("exec"), state: "reconcile_pending" };
    const execute = jest.fn<NonNullable<CodespaceToolServices["operation"]>["execute"]>();
    const reconcile = jest.fn<NonNullable<CodespaceToolServices["operation"]>["reconcile"]>(
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
        get: jest.fn<NonNullable<CodespaceToolServices["operation"]>["get"]>(() => current),
        reconcile,
        execute,
      },
    });

    const resumed = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "exec",
        codespace_id: CODESPACE_ID,
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
    ["failed", "CODESPACE_OPERATION_FAILED"],
    ["cancelled", "CODESPACE_OPERATION_CANCELLED"],
    ["timed_out", "CODESPACE_OPERATION_TIMED_OUT"],
  ] as const)(
    "exposes terminal exec %s as a tool error with its operation identity",
    async (state, code) => {
      const base = services();
      const response = await executeCodespaceTool(
        parseCodespaceToolParams({
          action: "exec",
          codespace_id: CODESPACE_ID,
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

  it("tells a command lost to a codespace restart apart from one that failed on its own", async () => {
    let current: CodespaceOperationRecord = { ...operation("exec"), state: "running" };
    const base = services();
    const response = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "exec",
        codespace_id: CODESPACE_ID,
        operation_id: OPERATION_ID,
      }),
      USER_ID,
      services({
        operation: {
          ...base.operation!,
          get: jest.fn<NonNullable<CodespaceToolServices["operation"]>["get"]>(() => current),
          reconcile: jest.fn(async () => {
            current = {
              ...operation("exec"),
              state: "failed" as const,
              exitCode: null,
              lastOutcome: "codespace_restarted",
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
        error: { code: "CODESPACE_OPERATION_INTERRUPTED", retryable: false },
      },
    });
    expect(JSON.stringify(data(response))).toContain("restarted");
  });

  it("reports a rejected file edit as an error, retaining the durable operation", async () => {
    const base = services();
    const response = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "write",
        codespace_id: CODESPACE_ID,
        path: "source.txt",
        text: "new",
        expected: { exists: false },
      }),
      USER_ID,
      services({
        file: {
          ...base.file!,
          execute: jest.fn<NonNullable<CodespaceToolServices["file"]>["execute"]>(async () => ({
            operation: { ...operation("write"), state: "failed" as const },
            result: {
              action: "write" as const,
              state: "failed" as const,
              code: "CODESPACE_FILE_REJECTED",
            },
          })),
        },
      }),
    );
    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        operation: { operation_id: OPERATION_ID, state: "failed" },
        error: { code: "CODESPACE_FILE_REJECTED" },
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
            referenceId: `codespace-file://${"x".repeat(43)}`,
            fileName: "result.bin",
            mimeType: "application/octet-stream",
            size: 12,
            sha256: "c".repeat(64),
            expiresAt: 900,
          },
        })),
      },
    });
    const resumed = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "download",
        codespace_id: CODESPACE_ID,
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
      async (_userId: string, _codespaceId: string, request: { action: string }) => {
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
    const read = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "read",
        codespace_id: CODESPACE_ID,
        path: "src/index.ts",
        offset: 0,
        length: 5,
      }),
      USER_ID,
      dependencies,
    );
    const patched = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "apply_patch",
        codespace_id: CODESPACE_ID,
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
    const uploaded = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "upload",
        codespace_id: CODESPACE_ID,
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
    const downloaded = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "download",
        codespace_id: CODESPACE_ID,
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
      "/api/codespaces/transfers/",
    );
    expect(JSON.stringify([read, patched, uploaded, downloaded])).not.toMatch(/base64/i);
  });

  it("reports unexpected failures server-side while returning only a generic error", async () => {
    const reported: Array<{ name: string; error: unknown }> = [];
    const restore = setCodespaceToolFailureReporterForTests((name, error) =>
      reported.push({ name, error }),
    );
    try {
      const statusFailure = new Error("sqlite disk I/O error on /var/lib/moira/private.db");
      const statusBroken = services({
        connection: {
          getStatus: jest.fn(() => {
            throw statusFailure;
          }),
          refreshGrants: jest.fn(async () => ({ refreshed: false, stale: false })),
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

      const fromStatus = await executeCodespaceTool(
        parseCodespaceToolParams({ action: "list" }),
        USER_ID,
        statusBroken,
      );
      const fromService = await executeCodespaceTool(
        parseCodespaceToolParams({
          action: "write",
          codespace_id: CODESPACE_ID,
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
    const executed = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "exec",
        codespace_id: CODESPACE_ID,
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
    const ranged = await executeCodespaceTool(
      // Parsed the way the transport parses it, so the published range default is exercised.
      parseCodespaceToolParams({
        action: "read",
        codespace_id: CODESPACE_ID,
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

    // Naming a codespace the command does not belong to is refused, not silently answered.
    const foreignCodespace = services({
      operation: {
        ...base.operation!,
        get: jest.fn(() => ({ ...operation("exec"), resourceId: OTHER_CODESPACE_ID })),
        readOutput: jest.fn(async () => {
          throw new Error("a mismatched codespace must be refused before the service is reached");
        }),
      },
    });
    const mismatched = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "read",
        codespace_id: CODESPACE_ID,
        operation_id: OPERATION_ID,
        stream: "stdout",
      }),
      USER_ID,
      foreignCodespace,
    );
    expect((data(mismatched) as { error: { code: string } }).error.code).toBe(
      "CODESPACE_NOT_FOUND",
    );
    expect(foreignCodespace.operation!.readOutput).not.toHaveBeenCalled();
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
    const halted = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "exec",
        codespace_id: CODESPACE_ID,
        argv: ["flood"],
        cwd: ".",
        timeout_seconds: 60,
      }),
      USER_ID,
      stopped,
    );
    // A command stopped by the retained ceiling says so instead of reading as its own failure.
    expect((data(halted) as { error: { code: string } }).error.code).toBe(
      "CODESPACE_OPERATION_OUTPUT_LIMIT",
    );
  });

  it("passes a session through and never echoes what it stores", async () => {
    const base = services();
    const executed = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "exec",
        codespace_id: CODESPACE_ID,
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
      CODESPACE_ID,
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
    // codespace can read it here instead of being told only that creation was rejected.
    const base = services();
    const refusing = services({
      resource: {
        ...base.resource!,
        create: jest.fn(async () => {
          throw new CodespaceResourceError(
            "CODESPACE_CREATE_REJECTED",
            "Codespace creation was rejected",
            "retention_period_minutes exceeds the maximum for this owner",
          );
        }),
      },
    });

    const refused = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "create", repository_id: "42", ref: "main" }),
      USER_ID,
      refusing,
    );

    const error = (
      data(refused) as { error: { code: string; message: string; retryable: boolean } }
    ).error;
    expect(error.code).toBe("CODESPACE_CREATE_REJECTED");
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
          throw new CodespaceResourceError(
            "CODESPACE_POLICY_LIMIT",
            "Codespace per-user held limit reached",
            "You already hold 4 codespaces, which is the per-user ceiling. Stopped codespaces count too; delete one you no longer need to free a slot.",
          );
        }),
      },
    });
    const refused = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "create", repository_id: "42", ref: "main" }),
      USER_ID,
      named,
    );
    const refusedError = (data(refused) as { error: { code: string; message: string } }).error;
    expect(refusedError.code).toBe("CODESPACE_POLICY_LIMIT");
    expect(refusedError.message).toContain("per-user ceiling");
    expect((data(refused) as { error: { links: unknown[] } }).error.links).toEqual(
      services().guidance("ready").links,
    );

    const unnamed = services({
      resource: {
        ...base.resource!,
        create: jest.fn(async () => {
          throw new CodespaceResourceError("CODESPACE_POLICY_LIMIT", "operator-only sentence");
        }),
      },
    });
    const generic = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "create", repository_id: "42", ref: "main" }),
      USER_ID,
      unnamed,
    );
    const genericError = (data(generic) as { error: { message: string } }).error;
    expect(genericError.message).not.toContain("operator-only sentence");
    expect(genericError.message).toBe(
      "A codespace quota, concurrency, size or time limit was reached.",
    );
  });

  it.each([
    ["CONNECTION_REQUIRED", () => new CodespaceConnectionError("CONNECTION_REQUIRED", "refused")],
    [
      "INSTALLATION_REQUIRED",
      () => new CodespaceConnectionError("INSTALLATION_REQUIRED", "refused"),
    ],
    [
      "CODESPACE_NOT_CONFIGURED",
      () => new CodespaceConnectionError("CODESPACE_NOT_CONFIGURED", "refused"),
    ],
    ["AUTH_REFRESH_FAILED", () => new CodespaceConnectionError("AUTH_REFRESH_FAILED", "refused")],
    [
      "AUTH_GRANT_REVOCATION_REQUIRED",
      () => new CodespaceConnectionError("AUTH_GRANT_REVOCATION_REQUIRED", "refused"),
    ],
    [
      "CREDENTIAL_UNREADABLE",
      () => new CodespaceConnectionError("CREDENTIAL_UNREADABLE", "refused"),
    ],
    ["AUTHORIZATION_FAILED", () => new CodespaceConnectionError("AUTHORIZATION_FAILED", "refused")],
    [
      "REPOSITORY_NOT_ALLOWED",
      () => new CodespaceConnectionError("REPOSITORY_NOT_ALLOWED", "refused"),
    ],
    [
      "CODESPACE_AUTHORIZATION_REQUIRED",
      () => new CodespaceResourceError("CODESPACE_AUTHORIZATION_REQUIRED", "refused"),
    ],
    [
      "CODESPACE_PROVIDER_DISABLED",
      () => new CodespaceResourceError("CODESPACE_PROVIDER_DISABLED", "refused"),
    ],
    [
      "CODESPACE_POLICY_LIMIT",
      () => new CodespaceResourceError("CODESPACE_POLICY_LIMIT", "refused"),
    ],
  ] as Array<[string, () => Error]>)(
    "attaches provider guidance links to actionable refusal %s",
    async (code, failure) => {
      const base = services();
      const dependencies = services({
        resource: {
          ...base.resource!,
          create: jest.fn(async () => {
            throw failure();
          }),
        },
      });

      const result = await executeCodespaceTool(
        parseCodespaceToolParams({ action: "create", repository_id: "42", ref: "main" }),
        USER_ID,
        dependencies,
      );
      expect(data(result)).toMatchObject({
        error: { code, links: dependencies.guidance("ready").links },
      });
    },
  );

  it("returns bounded setup, foreign-codespace, and binary-read errors", async () => {
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
        refreshGrants: jest.fn(async () => ({ refreshed: false, stale: false })),
      },
    });
    const setup = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "start", codespace_id: CODESPACE_ID }),
      USER_ID,
      disconnected,
    );

    const foreign = services({
      resource: {
        ...services().resource!,
        getCodespace: jest.fn(() => {
          throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "foreign detail");
        }),
      },
    });
    const missing = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "get", codespace_id: CODESPACE_ID }),
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
    const unreadable = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "read",
        codespace_id: CODESPACE_ID,
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
          links: services().guidance("ready").links,
        },
      },
    });
    expect(missing).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "CODESPACE_NOT_FOUND" } },
    });
    expect(JSON.stringify(missing)).not.toContain("foreign detail");
    expect(unreadable).toMatchObject({
      isError: true,
      structuredContent: {
        operation: { operation_id: OPERATION_ID, state: "succeeded" },
        error: { code: "CODESPACE_BINARY_READ_REQUIRES_DOWNLOAD" },
      },
    });
  });

  it("fills published defaults so a minimal call is a complete strict request", () => {
    // The parsed call carries the action that selected the contract beside the request it accepted.
    expect(
      parseCodespaceToolParams({ action: "read", codespace_id: CODESPACE_ID, path: "a" }),
    ).toEqual({
      action: "read",
      request: { codespace_id: CODESPACE_ID, path: "a", offset: 0, length: 64 * 1024 },
    });
    expect(
      parseCodespaceToolParams({
        action: "search",
        codespace_id: CODESPACE_ID,
        path: ".",
        query: "TODO",
      }),
    ).toEqual({
      action: "search",
      request: {
        codespace_id: CODESPACE_ID,
        path: ".",
        query: "TODO",
        mode: "literal",
        max_matches: 100,
        max_bytes: 64 * 1024,
      },
    });
    expect(
      parseCodespaceToolParams({ action: "exec", codespace_id: CODESPACE_ID, argv: ["ls"] }),
      // A bounded command names no duration: the service applies the default its mode implies.
    ).toEqual({
      action: "exec",
      request: {
        codespace_id: CODESPACE_ID,
        argv: ["ls"],
        background: false,
        session_start: false,
        session_end: false,
      },
    });
    expect(
      parseCodespaceToolParams({
        action: "download",
        codespace_id: CODESPACE_ID,
        path: "dist/app.zip",
        file_name: "app.zip",
        mime_type: "application/zip",
      }),
    ).toMatchObject({ action: "download", request: { max_bytes: 4 * 1024 * 1024 } });
  });

  it("names the missing or invalid fields of an incomplete request instead of a generic error", async () => {
    expect(() =>
      parseCodespaceToolParams({ action: "search", codespace_id: CODESPACE_ID, path: "." }),
    ).toThrow(CodespaceRequestInvalidError);
    let detail = "";
    try {
      parseCodespaceToolParams({
        action: "write",
        codespace_id: CODESPACE_ID,
        path: "src/index.ts",
        text: "print('a secret value')",
      });
    } catch (error) {
      detail = (error as CodespaceRequestInvalidError).detail;
    }
    expect(detail).toBe("expected: Required");

    const restoreLoader = setCodespaceToolServicesLoaderForTests(async () => services());
    try {
      const result = await requestContext.run({ userId: USER_ID }, () =>
        manageCodespaceTool({
          action: "read",
          codespace_id: CODESPACE_ID,
          path: "README.md",
          length: "all of it",
        }),
      );
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "CODESPACE_REQUEST_INVALID",
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
    ["list", { codespace_id: CODESPACE_ID }],
    ["create", { repository_id: "42", ref: "main", codespace_id: CODESPACE_ID }],
    ["get", { codespace_id: CODESPACE_ID, path: "README.md" }],
    ["start", { codespace_id: CODESPACE_ID, argv: ["ls"] }],
    ["stop", { codespace_id: CODESPACE_ID, confirm_delete: true }],
    [
      "delete",
      {
        codespace_id: CODESPACE_ID,
        expected_generation: 3,
        confirm_delete: true,
        query: "TODO",
      },
    ],
    ["exec", { codespace_id: CODESPACE_ID, argv: ["ls"], path: "README.md" }],
    ["stat", { codespace_id: CODESPACE_ID, path: "README.md", argv: ["ls"] }],
    ["search", { codespace_id: CODESPACE_ID, path: ".", query: "TODO", text: "x" }],
    ["read", { codespace_id: CODESPACE_ID, path: "README.md", query: "TODO" }],
    [
      "write",
      {
        codespace_id: CODESPACE_ID,
        path: "a.txt",
        text: "x",
        expected: { exists: false },
        cwd: ".",
      },
    ],
    [
      "apply_patch",
      {
        codespace_id: CODESPACE_ID,
        files: [
          { path: "a.txt", expected: { exists: true }, edits: [{ start: 0, end: 1, text: "y" }] },
        ],
        text: "x",
      },
    ],
    [
      "upload",
      {
        codespace_id: CODESPACE_ID,
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
        codespace_id: CODESPACE_ID,
        path: "a.bin",
        file_name: "a.bin",
        mime_type: "application/octet-stream",
        query: "TODO",
      },
    ],
  ])("refuses action %s a field that belongs to another action", (action, request) => {
    expect(() => parseCodespaceToolParams({ action, ...request })).toThrow(
      CodespaceRequestInvalidError,
    );
  });

  // The mirror of the rows above: those prove the published object accepts too much and dispatch
  // refuses the excess. These prove it does not accept too little — a collapse that narrowed one
  // action's field while merging it would pass every foreign-argument row and fail here. Each
  // payload carries that action's boundary values, so a bound lost in the projection is visible.
  it.each([
    ["list", {}],
    ["create", { repository_id: "42", ref: "main" }],
    ["get", { codespace_id: CODESPACE_ID }],
    ["start", { codespace_id: CODESPACE_ID }],
    ["stop", { codespace_id: CODESPACE_ID }],
    ["delete", { codespace_id: CODESPACE_ID, expected_generation: 3, confirm_delete: true }],
    [
      "exec",
      {
        codespace_id: CODESPACE_ID,
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
    ["stat", { codespace_id: CODESPACE_ID, path: "package.json" }],
    [
      "search",
      {
        codespace_id: CODESPACE_ID,
        path: ".",
        query: "TODO",
        mode: "regex",
        max_matches: 1000,
        max_bytes: 1024 * 1024,
      },
    ],
    ["read", { codespace_id: CODESPACE_ID, path: "a.txt", offset: 0, length: 4 * 1024 * 1024 }],
    [
      "read",
      { codespace_id: CODESPACE_ID, operation_id: OPERATION_ID, stream: "stderr", length: 1 },
    ],
    [
      "write",
      {
        codespace_id: CODESPACE_ID,
        path: "a.txt",
        text: "x",
        expected: { exists: true, size_bytes: 1, sha256: "a".repeat(64) },
      },
    ],
    [
      "apply_patch",
      {
        codespace_id: CODESPACE_ID,
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
        codespace_id: CODESPACE_ID,
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
        codespace_id: CODESPACE_ID,
        path: "a.bin",
        file_name: "a.bin",
        mime_type: "application/octet-stream",
        max_bytes: 4 * 1024 * 1024,
      },
    ],
    [
      "download",
      {
        codespace_id: CODESPACE_ID,
        operation_id: OPERATION_ID,
        file_name: "a.bin",
        mime_type: "application/octet-stream",
      },
    ],
  ])("publishes a payload action %s accepts", (action, request) => {
    const payload = { action, ...request };
    expect(codespaceSchema.safeParse(payload).success).toBe(true);
    expect(() => parseCodespaceToolParams(payload)).not.toThrow();
  });

  it("refuses an unknown action and a field belonging to no action at all", async () => {
    // An action nobody serves is refused before any contract is chosen for it.
    expect(() => parseCodespaceToolParams({ action: "teleport" })).toThrow(
      CodespaceRequestInvalidError,
    );
    expect(() => parseCodespaceToolParams({ codespace_id: CODESPACE_ID })).toThrow(
      CodespaceRequestInvalidError,
    );
    // A field no action declares never reaches dispatch: the published object is still strict.
    expect(codespaceSchema.safeParse({ action: "list", chat_id: "c1" }).success).toBe(false);
    // Every action the tool dispatches is an action the published object offers, so none of them is
    // unreachable through the catalog.
    expect(
      [...((codespaceSchema.shape.action as z.ZodEnum<[string, ...string[]]>).options as string[])]
        .sort()
        .join(","),
    ).toBe(Object.keys(CODESPACE_ACTION_REQUEST_SCHEMAS).sort().join(","));
  });
});
