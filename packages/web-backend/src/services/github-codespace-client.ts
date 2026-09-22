import {
  GitHubCodespaceClient,
  GitHubCodespaceInstallation,
  GitHubCodespaceRepository,
  GitHubCodespaceTokenResponse,
  GitHubCodespaceUser,
  CODESPACE_PROVIDER_CONTRACT_VERSION,
  CODESPACE_PROVIDER_GITHUB,
  type CodespaceMachine,
  type CodespaceProviderAdapter,
  type CodespaceProviderGuidance,
  type CodespaceProviderResource,
  type CodespaceProviderState,
  type CodespaceRepositoryTarget,
  type CodespaceGitHubConfigStatus,
} from "@mcp-moira/shared";

type AvailableConfig = Extract<CodespaceGitHubConfigStatus, { state: "available" }>;
type Fetch = typeof fetch;

const API_ORIGIN = "https://api.github.com";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 30_000;

/** Provider-owned destinations and instructions, available even before the runtime client can start. */
export function githubCodespaceGuidance(
  config: CodespaceGitHubConfigStatus,
): CodespaceProviderGuidance {
  return {
    links: [
      { id: "settings", url: config.settingsUrl, label: "Moira settings" },
      ...(config.state === "available"
        ? [
            {
              id: "install" as const,
              url: config.installationUrl,
              label: "GitHub App installation",
            },
          ]
        : []),
      { id: "create_repository", url: "https://github.com/new", label: "New GitHub repository" },
      { id: "provider_console", url: "https://github.com/codespaces", label: "Your codespaces" },
    ],
    instructions: {
      not_configured:
        "This Moira instance has no GitHub connection configured; an administrator must configure it before codespaces can be used.",
      instance_disabled:
        "Codespaces are disabled on this Moira instance; ask its administrator to enable them.",
      connection_required: "Connect your GitHub account in Moira settings.",
      installation_required:
        "Install the Moira GitHub App on your account and grant it the repositories you want to work in.",
      authorization_repair_required:
        "Repair the GitHub authorization in Moira settings and follow any displayed revocation or reconnection step.",
      repository_not_approved:
        "Moira cannot create a repository: create it on GitHub if needed, then add it to the Moira GitHub App installation.",
      ceiling_reached:
        "You have reached a codespace limit; delete one you no longer need, or wait for capacity to become available.",
      ready: "GitHub is connected and the repositories you granted are available.",
    },
  };
}

export class GitHubCodespaceClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /**
     * What the provider said about its own refusal, already redacted and bounded by
     * {@link providerRefusalMessage}. Absent when the provider said nothing usable — a caller then
     * sees exactly what it saw before this existed: the status alone.
     */
    public readonly providerMessage?: string,
  ) {
    super(message);
    this.name = "GitHubCodespaceClientError";
  }
}

/** Longest provider message kept. Long enough for GitHub's sentences, short enough to store. */
const PROVIDER_MESSAGE_LIMIT = 300;

/**
 * Patterns that must never survive into a stored record. A refusal body is provider text, and text
 * that looks like a credential or a URL is dropped rather than trimmed: a partially redacted secret
 * is still a secret, and an audit row is read long after the request is gone.
 */
const SECRET_SHAPED = [
  /\bgh[pousr]_[A-Za-z0-9]{8,}/, // GitHub token prefixes
  /\bgithub_pat_[A-Za-z0-9_]{8,}/,
  /\b(?:bearer|token|authorization|secret|password)\b\s*[:=]?\s*\S+/i,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT-shaped
  /https?:\/\/\S+/i,
];

/**
 * The provider's own reason for refusing, safe to store and to show a caller.
 *
 * GitHub answers a refusal with `{ message, errors: [{ message }] }`, sometimes with HTML, sometimes
 * with nothing. Whatever arrives is reduced to one line, checked against the patterns above and
 * capped; anything unreadable or unsafe yields `undefined`, which leaves the refusal exactly as
 * informative as it was before — the status — rather than risking a leak for a better sentence.
 */
export function providerRefusalMessage(body: string): string | undefined {
  const text = body.trim();
  if (!text) return undefined;

  let message = "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const record = parsed as { message?: unknown; errors?: unknown };
      const head = typeof record.message === "string" ? record.message : "";
      const details = Array.isArray(record.errors)
        ? record.errors
            .map((entry) =>
              entry &&
              typeof entry === "object" &&
              typeof (entry as { message?: unknown }).message === "string"
                ? (entry as { message: string }).message
                : "",
            )
            .filter((entry) => entry.length > 0)
        : [];
      message = [head, ...details].filter((part) => part.length > 0).join(" ");
    }
  } catch {
    // Not JSON: GitHub also answers with HTML or plain text, which is still worth carrying.
    message = text;
  }
  if (!message) return undefined;

  const collapsed = message
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return undefined;
  if (SECRET_SHAPED.some((pattern) => pattern.test(collapsed))) return undefined;
  return collapsed.slice(0, PROVIDER_MESSAGE_LIMIT);
}

function decimalId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,39}$/.test(value)) return value;
  throw new GitHubCodespaceClientError("GitHub returned an invalid identifier", 502);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitHubCodespaceClientError(`GitHub response omitted ${field}`, 502);
  }
  return value;
}

/**
 * GitHub's codespace states, lower-cased, mapped onto the provider contract. GitHub documents
 * Unknown, Created, Queued, Provisioning, Available, Awaiting, Unavailable, Deleted, Moved, Shutdown,
 * Archived, Starting, ShuttingDown, Failed, Exporting, Updating and Rebuilding. The judgment calls:
 * - Rebuilding, Updating, Exporting and Moved are provider-side operations after which the
 *   codespace comes back; they are `starting` so lifecycle work waits instead of acting.
 * - Archived is a stopped codespace GitHub has archived; starting it restores it, so it is
 *   `shutdown`.
 * - Deleted reads as `deleting`: the exact resource is going away and is confirmed by its absence.
 * - Unavailable joins Failed. Anything unrecognised is `provisioning`, so an unfamiliar state is
 *   waited on rather than acted on.
 */
const GITHUB_CODESPACE_STATES: Readonly<Record<string, CodespaceProviderState>> = {
  available: "available",
  shutdown: "shutdown",
  archived: "shutdown",
  shuttingdown: "stopping",
  starting: "starting",
  rebuilding: "starting",
  updating: "starting",
  exporting: "starting",
  moved: "starting",
  created: "provisioning",
  queued: "provisioning",
  provisioning: "provisioning",
  awaiting: "provisioning",
  deleted: "deleting",
  deleting: "deleting",
  failed: "failed",
  unavailable: "failed",
};

/**
 * GitHub sets `pending_operation` while an asynchronous operation holds the codespace; until it
 * clears, the codespace accepts nothing but deletion. A settled state under a pending operation is
 * therefore reported as the transition it is in: a running codespace is not yet usable, and a shut
 * down one has not yet settled.
 */
function codespaceState(rawState: string, pendingOperation: boolean): CodespaceProviderState {
  const state = GITHUB_CODESPACE_STATES[rawState.toLowerCase()] ?? "provisioning";
  if (!pendingOperation) return state;
  if (state === "available") return "starting";
  if (state === "shutdown") return "stopping";
  return state;
}

function repositoryPath(fullName: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new GitHubCodespaceClientError("GitHub returned an invalid repository name", 502);
  }
  return fullName.split("/").map(encodeURIComponent).join("/");
}

export class HttpGitHubCodespaceClient implements GitHubCodespaceClient, CodespaceProviderAdapter {
  readonly id = CODESPACE_PROVIDER_GITHUB;
  readonly contractVersion = CODESPACE_PROVIDER_CONTRACT_VERSION;
  readonly capabilities = {
    disposable: true,
    persistent: true,
    exactLifecycle: true,
    personalBillingOnly: true,
    connector: "github-cli-ssh",
  } as const;

  /**
   * GitHub's own answer to "what must the user do, and where". Moira decides which situation applies;
   * the words and the destinations are the provider's, so a second provider supplies its own instead
   * of inheriting GitHub's console.
   */
  guidance(): CodespaceProviderGuidance {
    return githubCodespaceGuidance(this.config);
  }

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

  private async tokenRequest(parameters: URLSearchParams): Promise<GitHubCodespaceTokenResponse> {
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
      throw new GitHubCodespaceClientError("GitHub credential exchange failed", response.status);
    }
    const expiresIn = body.expires_in;
    const refreshExpiresIn = body.refresh_token_expires_in;
    if (
      typeof expiresIn !== "number" ||
      !Number.isSafeInteger(expiresIn) ||
      typeof refreshExpiresIn !== "number" ||
      !Number.isSafeInteger(refreshExpiresIn)
    ) {
      throw new GitHubCodespaceClientError("GitHub did not return expiring user tokens", 502);
    }
    const now = this.now();
    return {
      accessToken: requiredString(body.access_token, "access token"),
      refreshToken: requiredString(body.refresh_token, "refresh token"),
      accessTokenExpiresAt: now + expiresIn * 1000,
      refreshTokenExpiresAt: now + refreshExpiresIn * 1000,
    };
  }

  exchangeCode(code: string): Promise<GitHubCodespaceTokenResponse> {
    return this.tokenRequest(
      new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.callbackUrl,
      }),
    );
  }

  refreshToken(refreshToken: string): Promise<GitHubCodespaceTokenResponse> {
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
      throw new GitHubCodespaceClientError("GitHub pagination left the API origin", 502);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(parsed, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "Moira-Codespace-Connector",
        },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof GitHubCodespaceClientError) throw error;
      throw new GitHubCodespaceClientError("GitHub API request failed", 503);
    }
    if (!(acceptedStatuses?.includes(response.status) ?? response.ok)) {
      // The body is where the provider says which rule was broken; reading it here means every
      // operation carries the reason, not only the one that happens to have a rejected outcome.
      const failureBody = await response.text().catch(() => "");
      throw new GitHubCodespaceClientError(
        `GitHub API request failed (HTTP ${response.status})`,
        response.status,
        providerRefusalMessage(failureBody),
      );
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
      if (!result.body || typeof result.body !== "object") {
        throw new GitHubCodespaceClientError("GitHub returned an invalid JSON response", 502);
      }
      collected.push(...items(result.body));
      const link: string = result.response.headers.get("link") ?? "";
      const match: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
      next = match?.[1] ?? null;
    }
    if (next) throw new GitHubCodespaceClientError("GitHub pagination exceeded its bound", 502);
    return collected;
  }

  async getUser(accessToken: string): Promise<GitHubCodespaceUser> {
    const body = await this.api<Record<string, unknown>>("/user", accessToken);
    if (!body || typeof body !== "object") {
      throw new GitHubCodespaceClientError("GitHub returned an invalid JSON response", 502);
    }
    return { id: decimalId(body.id), login: requiredString(body.login, "login") };
  }

  getIdentity(accessToken: string): Promise<GitHubCodespaceUser> {
    return this.getUser(accessToken);
  }

  private parseMachine(value: unknown): CodespaceMachine {
    const machine = value as Record<string, unknown>;
    const positiveInteger = (field: string): number => {
      const item = machine[field];
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
        throw new GitHubCodespaceClientError(`GitHub returned an invalid machine ${field}`, 502);
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

  private parseCodespace(value: unknown): CodespaceProviderResource {
    const codespace = value as Record<string, unknown>;
    const owner = codespace.owner as Record<string, unknown> | undefined;
    const billableOwner = codespace.billable_owner as Record<string, unknown> | undefined;
    const repository = codespace.repository as Record<string, unknown> | undefined;
    const gitStatus = codespace.git_status as Record<string, unknown> | undefined;
    const state = codespaceState(
      requiredString(codespace.state, "codespace state"),
      codespace.pending_operation === true,
    );
    const createdAt = Date.parse(requiredString(codespace.created_at, "codespace created time"));
    if (!Number.isFinite(createdAt)) {
      throw new GitHubCodespaceClientError(
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
      // The checked-out ref is working state, and a detached HEAD or a git status GitHub has not
      // filled in yet has none; neither makes the codespace unreadable.
      ref: typeof gitStatus?.ref === "string" && gitStatus.ref.length > 0 ? gitStatus.ref : null,
      state,
      machine: codespace.machine ? this.parseMachine(codespace.machine) : null,
      createdAt,
    };
  }

  async listMachines(
    accessToken: string,
    repository: CodespaceRepositoryTarget,
    ref: string,
  ): Promise<CodespaceMachine[]> {
    // GitHub answers per ref: the machines available on a branch are not always the ones available on
    // the default branch, and asking without the ref quietly answers the wrong question.
    const path = `/repos/${repositoryPath(repository.fullName)}/codespaces/machines?ref=${encodeURIComponent(ref)}`;
    const body = await this.api<Record<string, unknown>>(path, accessToken);
    return (Array.isArray(body.machines) ? body.machines : []).map((machine) =>
      this.parseMachine(machine),
    );
  }

  async create(
    accessToken: string,
    input: Parameters<CodespaceProviderAdapter["create"]>[1],
  ): Promise<Awaited<ReturnType<CodespaceProviderAdapter["create"]>>> {
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
        error instanceof GitHubCodespaceClientError &&
        [400, 403, 404, 409, 422, 429].includes(error.status)
      ) {
        return {
          outcome: "rejected",
          reason: `github_status_${error.status}`,
          ...(error.providerMessage ? { detail: error.providerMessage } : {}),
        };
      }
      throw error;
    }
  }

  async listOwned(accessToken: string): Promise<CodespaceProviderResource[]> {
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
  ): Promise<CodespaceProviderResource | null> {
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
    action: "start" | "stop" | "delete",
  ): Promise<"accepted" | "absent"> {
    const acceptedStatuses =
      action === "start"
        ? ([200, 202, 304, 404] as const)
        : action === "stop"
          ? ([200, 202, 404] as const)
          : ([202, 204, 304, 404] as const);
    const result = await this.apiResponse<undefined>(
      `/user/codespaces/${encodeURIComponent(resourceName)}${action === "delete" ? "" : `/${action}`}`,
      accessToken,
      { method: action === "delete" ? "DELETE" : "POST" },
      acceptedStatuses,
    );
    return result.response.status === 404 ? "absent" : "accepted";
  }

  startExact(accessToken: string, resourceName: string): Promise<"accepted" | "absent"> {
    return this.lifecycle(accessToken, resourceName, "start");
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

  async listInstallations(accessToken: string): Promise<GitHubCodespaceInstallation[]> {
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
  ): Promise<GitHubCodespaceRepository[]> {
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
          "User-Agent": "Moira-Codespace-Connector",
        },
        body: JSON.stringify({ access_token: accessToken }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new GitHubCodespaceClientError("GitHub credential revocation failed", response.status);
    }
  }

  revokeToken(accessToken: string): Promise<void> {
    return this.revoke("token", accessToken);
  }

  revokeGrant(accessToken: string): Promise<void> {
    return this.revoke("grant", accessToken);
  }
}
