import {
  GitHubWorkspaceClient,
  GitHubWorkspaceInstallation,
  GitHubWorkspaceRepository,
  GitHubWorkspaceTokenResponse,
  GitHubWorkspaceUser,
  WORKSPACE_PROVIDER_CONTRACT_VERSION,
  WORKSPACE_PROVIDER_GITHUB,
  type WorkspaceMachine,
  type WorkspaceProviderAdapter,
  type WorkspaceProviderResource,
  type WorkspaceRepositoryTarget,
  type WorkspaceGitHubConfigStatus,
} from "@mcp-moira/shared";

type AvailableConfig = Extract<WorkspaceGitHubConfigStatus, { state: "available" }>;
type Fetch = typeof fetch;

const API_ORIGIN = "https://api.github.com";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 30_000;

export class GitHubWorkspaceClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GitHubWorkspaceClientError";
  }
}

function decimalId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,39}$/.test(value)) return value;
  throw new GitHubWorkspaceClientError("GitHub returned an invalid identifier", 502);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitHubWorkspaceClientError(`GitHub response omitted ${field}`, 502);
  }
  return value;
}

function repositoryPath(fullName: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new GitHubWorkspaceClientError("GitHub returned an invalid repository name", 502);
  }
  return fullName.split("/").map(encodeURIComponent).join("/");
}

export class HttpGitHubWorkspaceClient implements GitHubWorkspaceClient, WorkspaceProviderAdapter {
  readonly id = WORKSPACE_PROVIDER_GITHUB;
  readonly contractVersion = WORKSPACE_PROVIDER_CONTRACT_VERSION;
  readonly capabilities = {
    disposable: true,
    exactLifecycle: true,
    personalBillingOnly: true,
    connector: "github-cli-ssh",
  } as const;

  constructor(
    private readonly config: AvailableConfig,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly connectorHealth: () => Promise<{
      ok: boolean;
      reason: string | null;
    }> = async () => ({
      ok: false,
      reason: "Connector health probe is not configured",
    }),
    private readonly connectorProbe: (
      accessToken: string,
      resourceName: string,
    ) => Promise<void> = async () => {
      throw new Error("Connector capability probe is not configured");
    },
  ) {}

  async health(): Promise<{ state: "available" | "unavailable"; reason: string | null }> {
    const result = await this.connectorHealth();
    return result.ok
      ? { state: "available", reason: null }
      : { state: "unavailable", reason: result.reason ?? "Connector tooling is unavailable" };
  }

  private async tokenRequest(parameters: URLSearchParams): Promise<GitHubWorkspaceTokenResponse> {
    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: parameters,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || body.error) {
      throw new GitHubWorkspaceClientError("GitHub credential exchange failed", response.status);
    }
    const expiresIn = body.expires_in;
    const refreshExpiresIn = body.refresh_token_expires_in;
    if (
      typeof expiresIn !== "number" ||
      !Number.isSafeInteger(expiresIn) ||
      typeof refreshExpiresIn !== "number" ||
      !Number.isSafeInteger(refreshExpiresIn)
    ) {
      throw new GitHubWorkspaceClientError("GitHub did not return expiring user tokens", 502);
    }
    const now = this.now();
    return {
      accessToken: requiredString(body.access_token, "access token"),
      refreshToken: requiredString(body.refresh_token, "refresh token"),
      accessTokenExpiresAt: now + expiresIn * 1000,
      refreshTokenExpiresAt: now + refreshExpiresIn * 1000,
    };
  }

  exchangeCode(code: string): Promise<GitHubWorkspaceTokenResponse> {
    return this.tokenRequest(
      new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.callbackUrl,
      }),
    );
  }

  refreshToken(refreshToken: string): Promise<GitHubWorkspaceTokenResponse> {
    return this.tokenRequest(
      new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    );
  }

  private async apiResponse<T>(
    url: string,
    accessToken: string,
    init: Pick<RequestInit, "method" | "body"> = {},
    acceptedStatuses?: readonly number[],
  ): Promise<{ body: T; response: Response }> {
    const parsed = new URL(url, API_ORIGIN);
    if (parsed.origin !== API_ORIGIN) {
      throw new GitHubWorkspaceClientError("GitHub pagination left the API origin", 502);
    }
    const response = await this.fetchImpl(parsed, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "Moira-Workspace-Connector",
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!(acceptedStatuses?.includes(response.status) ?? response.ok)) {
      throw new GitHubWorkspaceClientError("GitHub API request failed", response.status);
    }
    const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    return { body: body as T, response };
  }

  private async api<T>(path: string, accessToken: string): Promise<T> {
    return (await this.apiResponse<T>(path, accessToken)).body;
  }

  private async paginated<T>(
    path: string,
    accessToken: string,
    items: (body: Record<string, unknown>) => T[],
  ): Promise<T[]> {
    const collected: T[] = [];
    let next: string | null = path;
    for (let page = 0; next && page < 20; page++) {
      const result: { body: Record<string, unknown>; response: Response } = await this.apiResponse<
        Record<string, unknown>
      >(next, accessToken);
      collected.push(...items(result.body));
      const link: string = result.response.headers.get("link") ?? "";
      const match: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
      next = match?.[1] ?? null;
    }
    if (next) throw new GitHubWorkspaceClientError("GitHub pagination exceeded its bound", 502);
    return collected;
  }

  async getUser(accessToken: string): Promise<GitHubWorkspaceUser> {
    const body = await this.api<Record<string, unknown>>("/user", accessToken);
    return { id: decimalId(body.id), login: requiredString(body.login, "login") };
  }

  getIdentity(accessToken: string): Promise<GitHubWorkspaceUser> {
    return this.getUser(accessToken);
  }

  private parseMachine(value: unknown): WorkspaceMachine {
    const machine = value as Record<string, unknown>;
    const positiveInteger = (field: string): number => {
      const item = machine[field];
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
        throw new GitHubWorkspaceClientError(`GitHub returned an invalid machine ${field}`, 502);
      }
      return item;
    };
    return {
      name: requiredString(machine.name, "machine name"),
      displayName: requiredString(machine.display_name, "machine display name"),
      operatingSystem: requiredString(machine.operating_system, "machine operating system"),
      cpuCores: positiveInteger("cpus"),
      memoryBytes: positiveInteger("memory_in_bytes"),
      storageBytes: positiveInteger("storage_in_bytes"),
    };
  }

  private parseCodespace(value: unknown): WorkspaceProviderResource {
    const codespace = value as Record<string, unknown>;
    const owner = codespace.owner as Record<string, unknown> | undefined;
    const billableOwner = codespace.billable_owner as Record<string, unknown> | undefined;
    const repository = codespace.repository as Record<string, unknown> | undefined;
    const gitStatus = codespace.git_status as Record<string, unknown> | undefined;
    const rawState = requiredString(codespace.state, "codespace state").toLowerCase();
    const state =
      rawState === "available"
        ? "available"
        : rawState === "shutdown"
          ? "shutdown"
          : rawState === "deleting"
            ? "deleting"
            : rawState === "failed" || rawState === "unavailable"
              ? "failed"
              : "provisioning";
    const createdAt = Date.parse(requiredString(codespace.created_at, "codespace created time"));
    if (!Number.isFinite(createdAt)) {
      throw new GitHubWorkspaceClientError(
        "GitHub returned an invalid codespace created time",
        502,
      );
    }
    return {
      name: requiredString(codespace.name, "codespace name"),
      displayName: requiredString(codespace.display_name, "codespace display name"),
      ownerId: decimalId(owner?.id),
      billableOwnerId: decimalId(billableOwner?.id),
      repositoryId: decimalId(repository?.id),
      repositoryFullName: requiredString(repository?.full_name, "codespace repository name"),
      ref: requiredString(gitStatus?.ref, "codespace ref"),
      state,
      machine: codespace.machine ? this.parseMachine(codespace.machine) : null,
      createdAt,
    };
  }

  async listMachines(
    accessToken: string,
    repository: WorkspaceRepositoryTarget,
  ): Promise<WorkspaceMachine[]> {
    const path = `/repos/${repositoryPath(repository.fullName)}/codespaces/machines`;
    const body = await this.api<Record<string, unknown>>(path, accessToken);
    return (Array.isArray(body.machines) ? body.machines : []).map((machine) =>
      this.parseMachine(machine),
    );
  }

  async create(
    accessToken: string,
    input: Parameters<WorkspaceProviderAdapter["create"]>[1],
  ): Promise<Awaited<ReturnType<WorkspaceProviderAdapter["create"]>>> {
    const path = `/repos/${repositoryPath(input.repository.fullName)}/codespaces`;
    try {
      const result = await this.apiResponse<Record<string, unknown>>(
        path,
        accessToken,
        {
          method: "POST",
          body: JSON.stringify({
            ref: input.ref,
            machine: input.machine.name,
            display_name: input.operationMarker,
            idle_timeout_minutes: input.idleTimeoutMinutes,
            retention_period_minutes: input.retentionMinutes,
          }),
        },
        [201, 202],
      );
      return {
        outcome: "accepted",
        resource:
          result.body && Object.keys(result.body).length > 0
            ? this.parseCodespace(result.body)
            : null,
      };
    } catch (error) {
      if (
        error instanceof GitHubWorkspaceClientError &&
        [400, 403, 404, 409, 422, 429].includes(error.status)
      ) {
        return { outcome: "rejected", reason: `github_status_${error.status}` };
      }
      throw error;
    }
  }

  async listOwned(accessToken: string): Promise<WorkspaceProviderResource[]> {
    const values = await this.paginated<Record<string, unknown>>(
      "/user/codespaces?per_page=100",
      accessToken,
      (body) => (Array.isArray(body.codespaces) ? body.codespaces : []),
    );
    return values.map((value) => this.parseCodespace(value));
  }

  async getExact(
    accessToken: string,
    resourceName: string,
  ): Promise<WorkspaceProviderResource | null> {
    const response = await this.apiResponse<Record<string, unknown> | undefined>(
      `/user/codespaces/${encodeURIComponent(resourceName)}`,
      accessToken,
      {},
      [200, 404],
    );
    return response.response.status === 404 ? null : this.parseCodespace(response.body);
  }

  private async lifecycle(
    accessToken: string,
    resourceName: string,
    action: "stop" | "delete",
  ): Promise<"accepted" | "absent"> {
    const result = await this.apiResponse<undefined>(
      `/user/codespaces/${encodeURIComponent(resourceName)}${action === "stop" ? "/stop" : ""}`,
      accessToken,
      { method: action === "stop" ? "POST" : "DELETE" },
      [202, 204, 404],
    );
    return result.response.status === 404 ? "absent" : "accepted";
  }

  stopExact(accessToken: string, resourceName: string): Promise<"accepted" | "absent"> {
    return this.lifecycle(accessToken, resourceName, "stop");
  }

  deleteExact(accessToken: string, resourceName: string): Promise<"accepted" | "absent"> {
    return this.lifecycle(accessToken, resourceName, "delete");
  }

  probeConnector(accessToken: string, resourceName: string): Promise<void> {
    return this.connectorProbe(accessToken, resourceName);
  }

  async listInstallations(accessToken: string): Promise<GitHubWorkspaceInstallation[]> {
    const installations = await this.paginated<Record<string, unknown>>(
      "/user/installations?per_page=100",
      accessToken,
      (body) => (Array.isArray(body.installations) ? body.installations : []),
    );
    return installations.map((installation) => {
      const account = installation.account as Record<string, unknown> | undefined;
      return {
        id: decimalId(installation.id),
        accountId: decimalId(account?.id),
        accountLogin: requiredString(account?.login, "installation account login"),
        targetType: requiredString(installation.target_type, "installation target type"),
        repositorySelection: installation.repository_selection === "all" ? "all" : "selected",
      };
    });
  }

  async listInstallationRepositories(
    accessToken: string,
    installationId: string,
  ): Promise<GitHubWorkspaceRepository[]> {
    const repositories = await this.paginated<Record<string, unknown>>(
      `/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=100`,
      accessToken,
      (body) => (Array.isArray(body.repositories) ? body.repositories : []),
    );
    return repositories.map((repository) => ({
      id: decimalId(repository.id),
      fullName: requiredString(repository.full_name, "repository name"),
      private: repository.private === true,
    }));
  }

  private async revoke(kind: "token" | "grant", accessToken: string): Promise<void> {
    const response = await this.fetchImpl(
      `${API_ORIGIN}/applications/${encodeURIComponent(this.config.clientId)}/${kind}`,
      {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "Moira-Workspace-Connector",
        },
        body: JSON.stringify({ access_token: accessToken }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new GitHubWorkspaceClientError("GitHub credential revocation failed", response.status);
    }
  }

  revokeToken(accessToken: string): Promise<void> {
    return this.revoke("token", accessToken);
  }

  revokeGrant(accessToken: string): Promise<void> {
    return this.revoke("grant", accessToken);
  }
}
