import { describe, expect, it, jest } from "@jest/globals";
import {
  LocalDeviceError,
  CodespaceResourceError,
  evaluateCodespaceResourcePolicy,
  projectCodespaceLimits,
  type CodespaceGuidanceSituation,
  type CodespaceResourceRecord,
} from "@mcp-moira/shared";

import {
  executeCodespaceTool,
  parseCodespaceToolParams,
  codespaceToolLogContext,
  CodespaceRequestInvalidError,
  type CodespaceToolServices,
} from "../../../packages/mcp-server/src/tools/manage-codespaces.js";
import { codespaceSchema } from "../../../packages/mcp-server/src/tools/tool-schemas.js";

const USER_ID = "user-a";
const CODESPACE_ID = "00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "ws1-00000000-0000-4000-8000-000000000002";
const OTHER_CODESPACE_ID = "00000000-0000-4000-8000-000000000003";
const REQUEST_ID = "ws1-00000000-0000-4000-8000-000000000004";
const OTHER_REQUEST_ID = "00000000-0000-4000-8000-000000000005";

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
    observedAt: null,
    lastOutcome: "verified_usable",
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

/** A user's limits as the domain computes them, from the shipped policy and some use. */
const LIMITS = projectCodespaceLimits({
  policy: evaluateCodespaceResourcePolicy(() => undefined),
  held: 2,
  instanceHeld: 5,
  idle: { autoStopEnabled: true, idleTimeoutMinutes: 30 },
  providerIdleMaxMinutes: 240,
});

function services(overrides: Partial<CodespaceToolServices> = {}): CodespaceToolServices {
  return {
    observability: {
      limitsWithBilling: jest.fn(async () => LIMITS),
      readiness: jest.fn(async () => ({
        state: "ready" as const,
        reason: null,
        provider: "github-codespaces",
        configuration: "available" as const,
        resources_enabled: true,
        controls: [],
        connector: { state: "available" as const, reason: null },
        reconciliation: { due_resources: 0, oldest_due_age_ms: null },
        usage: {
          active_resources: 1,
          max_active_resources: 4,
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
      refreshProviderState: jest.fn(async () => ({ stale: false })),
      getCodespace: jest.fn(() => codespace()),
      waitForState: jest.fn(
        async (_userId: string, _id: string, state: CodespaceResourceRecord["state"]) =>
          codespace({
            state,
            desiredState:
              state === "usable" ? "running" : state === "deleted" ? "deleted" : "stopped",
            observedState:
              state === "usable" ? "running" : state === "deleted" ? "absent" : "stopped",
          }),
      ),
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
    workspace: {
      request: async () => {
        throw new Error("Unexpected workspace call");
      },
      json: async () => {
        throw new Error("Unexpected workspace call");
      },
    },
    ...overrides,
  };
}

function data(result: Awaited<ReturnType<typeof executeCodespaceTool>>) {
  return result.structuredContent as Record<string, unknown>;
}

describe("codespace lifecycle and discovery adapter", () => {
  it("publishes and accepts the same Unicode PR branches as Git", () => {
    const input = {
      action: "pull_request_create",
      codespace_id: CODESPACE_ID,
      head: "feat/игра",
      base: "релиз",
      title: "Игра",
    };
    expect(codespaceSchema.safeParse(input).success).toBe(true);
    expect(parseCodespaceToolParams(input)).toMatchObject({
      action: "pull_request_create",
      request: { head: "feat/игра", base: "релиз" },
    });
    expect(
      parseCodespaceToolParams({
        action: "pull_request_find",
        codespace_id: CODESPACE_ID,
        head: "feat/игра",
        base: "релиз",
      }),
    ).toMatchObject({ action: "pull_request_find", request: { head: "feat/игра", base: "релиз" } });
  });
  it("creates and reads pull requests through the selected codespace without host access", async () => {
    let saved: {
      number: number;
      url: string;
      title: string;
      head: string;
      base: string;
      draft: boolean;
      body: string;
    } | null = null;
    const selected = services({ provider: "local-sandboxes" });
    const dependencies = services({
      select: () => selected,
      github: {
        createOwnedPullRequest: async (userId, id, input) => {
          if (userId !== USER_ID || id !== CODESPACE_ID)
            throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Denied");
          saved = {
            number: 7,
            url: "https://github.com/owner/repository/pull/7",
            ...input,
            body: input.body ?? "",
            draft: input.draft ?? false,
          };
          return saved;
        },
        getOwnedPullRequest: async (userId, id, number) => {
          if (userId !== USER_ID || id !== CODESPACE_ID || number !== saved?.number)
            throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Denied");
          return saved;
        },
        findOwnedPullRequests: async (userId, id, input) => {
          if (userId !== USER_ID || id !== CODESPACE_ID)
            throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Denied");
          return saved && saved.head === input.head && saved.base === input.base ? [saved] : [];
        },
      },
    });
    const created = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "pull_request_create",
        codespace_id: CODESPACE_ID,
        head: "feature/change",
        base: "main",
        title: "Change",
      }),
      USER_ID,
      dependencies,
    );
    const read = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "pull_request_get",
        codespace_id: CODESPACE_ID,
        pull_request_number: 7,
      }),
      USER_ID,
      dependencies,
    );
    expect(data(created)).toEqual({
      pull_request: {
        number: 7,
        url: "https://github.com/owner/repository/pull/7",
        head: "feature/change",
        base: "main",
        title: "Change",
        body: "",
        draft: false,
      },
    });
    expect(data(read)).toEqual(data(created));
    const found = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "pull_request_find",
        codespace_id: CODESPACE_ID,
        head: "feature/change",
        base: "main",
      }),
      USER_ID,
      dependencies,
    );
    expect(data(found)).toEqual({ pull_requests: [saved] });
    const denied = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "pull_request_get",
        codespace_id: OTHER_CODESPACE_ID,
        pull_request_number: 7,
      }),
      USER_ID,
      dependencies,
    );
    expect(denied).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "LOCAL_UNAUTHORIZED", message: "Denied" } },
    });
  });
  it.each([
    {
      action: "pull_request_create",
      codespace_id: CODESPACE_ID,
      head: "feature",
      base: "main",
      title: "Change",
      url: "https://api.github.com/user",
    },
    {
      action: "pull_request_get",
      codespace_id: CODESPACE_ID,
      pull_request_number: 7,
      head: "feature",
    },
  ])("refuses mixed and arbitrary GitHub API fields", (input) => {
    expect(() => parseCodespaceToolParams(input)).toThrow(CodespaceRequestInvalidError);
  });
  it.each(["private-token", "x".repeat(10000), `${CODESPACE_ID}\nprivate-source`, 42, null])(
    "omits malformed identifiers from pre-validation logging (%#)",
    (identifier) => {
      expect(
        codespaceToolLogContext({
          action: "exec",
          codespace_id: identifier,
          request_id: identifier,
        }),
      ).toEqual({ inputData: { codespace_action: "exec" }, resourceIds: {} });
    },
  );

  it("logs only opaque codespace/operation identity and never codespace input", () => {
    const projected = codespaceToolLogContext({
      action: "upload",
      codespace_id: CODESPACE_ID,
      request_id: OPERATION_ID,
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
      resourceIds: { codespaceId: CODESPACE_ID, requestId: OPERATION_ID },
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

    const brief = {
      codespace_id: CODESPACE_ID,
      repository: "owner/repository",
      ref: "feature/current",
      state: "usable",
    };
    expect(data(listed)).toEqual({ codespaces: [brief] });
    expect(dependencies.observability.limitsWithBilling).not.toHaveBeenCalled();
    expect(data(fetched)).toEqual(brief);
    const repositories = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "repositories" }),
      USER_ID,
      dependencies,
    );
    expect(data(repositories)).toEqual({
      repositories: [{ repository_id: "42", name: "owner/repository", private: true }],
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
      warning: "The provider could not refresh this view; the last confirmed entries are shown.",
      codespaces: [expect.objectContaining({ codespace_id: CODESPACE_ID })],
    });
    expect(dependencies.resource!.refreshProviderState).not.toHaveBeenCalled();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("refreshes managed provider state when list requests a fresh GitHub view", async () => {
    const dependencies = services();
    const listed = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "list", refresh: true }),
      USER_ID,
      dependencies,
    );
    expect(data(listed)).toHaveProperty("codespaces");
    expect(data(listed)).not.toHaveProperty("warning");
    expect(dependencies.resource!.refreshProviderState).toHaveBeenCalledWith(USER_ID, {
      authorizationFresh: true,
    });
    expect(dependencies.observability.limitsWithBilling).not.toHaveBeenCalled();
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
    const dependencies = services({ resource: null });
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
        confirm_delete: true,
      }),
      USER_ID,
      dependencies,
    );

    expect(JSON.stringify(created)).not.toContain("secret-capability");
    expect(dependencies.connection.refreshGrants).toHaveBeenCalledWith(USER_ID);
    expect(data(created)).toMatchObject({ codespace_id: CODESPACE_ID, state: "usable" });
    expect(data(stopped)).toMatchObject({ codespace_id: CODESPACE_ID, state: "stopped" });
    expect(data(deleted)).toMatchObject({ codespace_id: CODESPACE_ID, state: "deleted" });
    expect(dependencies.resource?.deleteCodespace).toHaveBeenCalledWith(USER_ID, CODESPACE_ID, 3);
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

  it("requires a stable identity for file mutations and rejects mixed command fields on inspection", () => {
    expect(() =>
      parseCodespaceToolParams({
        action: "write",
        codespace_id: CODESPACE_ID,
        path: "source.ts",
        text: "private",
        expected: { exists: false },
      }),
    ).toThrow(CodespaceRequestInvalidError);
    expect(() =>
      parseCodespaceToolParams({
        action: "exec",
        codespace_id: CODESPACE_ID,
        request_id: REQUEST_ID,
        env: { PRIVATE: "secret" },
      }),
    ).toThrow(CodespaceRequestInvalidError);
    expect(
      codespaceSchema.safeParse({
        action: "exec",
        codespace_id: CODESPACE_ID,
        request_id: REQUEST_ID,
        argv: ["printf", ""],
        timeout_seconds: 5 * 24 * 3600,
        max_stdout_bytes: 16 * 1024 * 1024,
      }).success,
    ).toBe(true);
  });
});
