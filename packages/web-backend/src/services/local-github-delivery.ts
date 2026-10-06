import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  CODESPACE_PROVIDER_GITHUB,
  LocalDeviceError,
  gitBranchSchema,
  type CodespaceConnectionService,
  type CodespaceConnectionRepository,
  type LocalDeviceAuth,
  type LocalPublicPolicy,
} from "@mcp-moira/shared";

export const gitDeliveryActionSchema = z.enum(["refs-fetch", "refs-push", "fetch", "push"]);
export type GitDeliveryAction = z.infer<typeof gitDeliveryActionSchema>;
export type GitHubDeliveryPermission = "fetch" | "push" | "pull_request";
const UNKNOWN_PULL_REQUEST =
  "The pull request outcome is unknown. Use codespace action pull_request_find with the same head and base before retrying creation.";
export const createPullRequestSchema = z
  .object({
    head: gitBranchSchema,
    base: gitBranchSchema,
    title: z.string().trim().min(1).max(256),
    body: z.string().max(65536).default(""),
    draft: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.head !== value.base, "Head and base must differ.");
export const findPullRequestsSchema = z
  .object({ head: gitBranchSchema, base: gitBranchSchema })
  .strict();
export interface GitHubPullRequest {
  number: number;
  url: string;
  state: "open" | "closed";
  title: string;
  head: string;
  base: string;
  draft: boolean;
}
export interface LocalGitHubDeliveryDependencies {
  connection: Pick<CodespaceConnectionService, "refreshGrants" | "getAccessToken">;
  connections: Pick<CodespaceConnectionRepository, "getConnection">;
  authorize: (
    auth: LocalDeviceAuth,
    resourceId: string,
    generation: number,
    action: GitHubDeliveryPermission,
  ) => LocalPublicPolicy["repositories"][number];
  fetch?: typeof globalThis.fetch;
  requestHttps?: typeof httpsRequest;
}

/** Credentials remain cloud-side; callers choose an operation, never a GitHub URL or token. */
export class LocalGitHubDelivery {
  constructor(private readonly dependencies: LocalGitHubDeliveryDependencies) {}

  private async authority(
    auth: LocalDeviceAuth,
    resourceId: string,
    generation: number,
    action: GitHubDeliveryPermission,
  ) {
    let repository = this.dependencies.authorize(auth, resourceId, generation, action);
    const refreshed = await this.dependencies.connection.refreshGrants(auth.userId, {
      force: true,
    });
    if (refreshed.stale)
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Refresh GitHub repository access in Settings.",
      );
    const token = await this.dependencies.connection.getAccessToken(auth.userId);
    repository = this.dependencies.authorize(auth, resourceId, generation, action);
    const connection = this.dependencies.connections.getConnection(
      auth.userId,
      CODESPACE_PROVIDER_GITHUB,
    );
    const granted = connection?.repositories.find(
      (item) =>
        item.fullName.toLowerCase() === repository.fullName.toLowerCase() &&
        item.private === repository.private,
    );
    if (
      connection?.status !== "connected" ||
      !granted ||
      !connection.installations.some(
        (item) => item.externalInstallationId === granted.externalInstallationId,
      )
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Add this repository to the Moira GitHub App installation in Settings.",
      );
    return { repository, connection, granted, token };
  }

  async identity(auth: LocalDeviceAuth, resourceId: string, generation: number) {
    const { connection } = await this.authority(auth, resourceId, generation, "fetch");
    if (
      !/^[0-9]+$/.test(connection.externalAccountId) ||
      !/^[A-Za-z0-9-]{1,39}$/.test(connection.externalLogin)
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Reconnect GitHub to restore the verified commit identity.",
      );
    return {
      name: connection.externalLogin,
      email: `${connection.externalAccountId}+${connection.externalLogin}@users.noreply.github.com`,
    };
  }

  async git(
    auth: LocalDeviceAuth,
    resourceId: string,
    generation: number,
    action: GitDeliveryAction,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    gitDeliveryActionSchema.parse(action);
    const push = action === "push" || action === "refs-push";
    const info = action.startsWith("refs-");
    if (request.method !== (info ? "GET" : "POST"))
      throw new LocalDeviceError("LOCAL_INVALID", "Invalid Git transport method.");
    const { repository, token } = await this.authority(
      auth,
      resourceId,
      generation,
      push ? "push" : "fetch",
    );
    const service = push ? "git-receive-pack" : "git-upload-pack";
    const upstream = (this.dependencies.requestHttps ?? httpsRequest)(
      {
        hostname: "github.com",
        port: 443,
        method: request.method,
        path: `/${repository.fullName}.git/${info ? `info/refs?service=${service}` : service}`,
        headers: {
          authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
          "user-agent": "Moira-Local-Git",
          accept: "*/*",
          ...(info ? {} : { "content-type": `application/x-${service}-request` }),
          ...(request.headers["git-protocol"] === "version=2"
            ? { "git-protocol": "version=2" }
            : {}),
        },
        agent: false,
        timeout: 15000,
        maxHeaderSize: 8192,
      },
      (reply) => {
        const status = reply.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          reply.destroy();
          response.writeHead(502).end();
          return;
        }
        response.writeHead(status, {
          "content-type":
            typeof reply.headers["content-type"] === "string"
              ? reply.headers["content-type"]
              : "application/octet-stream",
          "cache-control": "no-store",
          connection: "close",
        });
        reply.once("error", () => response.destroy());
        reply.pipe(response);
      },
    );
    // The local budget is narrower. This outer bound also limits malformed authenticated requests.
    let transferred = 0;
    const count = (chunk: Buffer) => {
      transferred += chunk.length;
      if (transferred > 16 * 1024 ** 3) {
        upstream.destroy();
        response.destroy();
      }
    };
    request.on("data", count);
    upstream.once("response", (reply) => reply.on("data", count));
    const deadline = setTimeout(() => upstream.destroy(), 120000);
    const recheck = setInterval(() => {
      try {
        this.dependencies.authorize(auth, resourceId, generation, push ? "push" : "fetch");
      } catch {
        upstream.destroy();
        response.destroy();
      }
    }, 1000);
    upstream.once("close", () => {
      clearTimeout(deadline);
      clearInterval(recheck);
    });
    upstream.once("timeout", () => upstream.destroy());
    upstream.once("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.once("aborted", () => upstream.destroy());
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  }

  private async pullRequestData(
    auth: LocalDeviceAuth,
    resourceId: string,
    generation: number,
    path: string,
    body?: z.infer<typeof createPullRequestSchema>,
  ) {
    const { repository, token } = await this.authority(
      auth,
      resourceId,
      generation,
      body ? "pull_request" : "fetch",
    );
    let reply: Response;
    try {
      reply = await (this.dependencies.fetch ?? globalThis.fetch)(
        `https://api.github.com/repos/${repository.fullName}/pulls${path}`,
        {
          method: body ? "POST" : "GET",
          redirect: "error",
          signal: AbortSignal.timeout(30000),
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "user-agent": "Moira-Local-Git",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
    } catch {
      throw new LocalDeviceError(
        "LOCAL_CONFLICT",
        body
          ? UNKNOWN_PULL_REQUEST
          : "GitHub could not be reached. Retry reading the pull request.",
      );
    }
    if (!reply.ok) {
      await reply.body?.cancel();
      throw new LocalDeviceError(
        reply.status === 403 || reply.status === 401 || reply.status === 404
          ? "LOCAL_UNAUTHORIZED"
          : "LOCAL_CONFLICT",
        reply.status === 403 || reply.status === 401 || reply.status === 404
          ? "Grant the Moira GitHub App Contents and Pull requests access to this repository, then refresh GitHub in Settings."
          : body && reply.status >= 500
            ? UNKNOWN_PULL_REQUEST
            : "GitHub refused this pull request. Check that both branches exist and differ.",
      );
    }
    let data: unknown;
    try {
      data = await reply.json();
    } catch {
      throw new LocalDeviceError(
        "LOCAL_CONFLICT",
        body ? UNKNOWN_PULL_REQUEST : "GitHub returned an unreadable pull request response.",
      );
    }
    return { data, repository };
  }

  private projectPullRequest(
    data: unknown,
    repository: LocalPublicPolicy["repositories"][number],
    mutation = false,
  ): GitHubPullRequest {
    const decoded = z
      .object({
        number: z.number().int().positive(),
        html_url: z.string().url(),
        state: z.enum(["open", "closed"]),
        title: z.string(),
        draft: z.boolean().default(false),
        head: z.object({ ref: z.string() }),
        base: z.object({ ref: z.string() }),
      })
      .safeParse(data);
    if (!decoded.success)
      throw new LocalDeviceError(
        "LOCAL_CONFLICT",
        mutation ? UNKNOWN_PULL_REQUEST : "GitHub returned an invalid pull request response.",
      );
    const parsed = decoded.data;
    const url = new URL(parsed.html_url);
    if (
      url.origin !== "https://github.com" ||
      url.pathname.toLowerCase() !== `/${repository.fullName}/pull/${parsed.number}`.toLowerCase()
    )
      throw new LocalDeviceError(
        "LOCAL_CONFLICT",
        "GitHub returned a pull request outside the approved repository.",
      );
    return {
      number: parsed.number,
      url: parsed.html_url,
      state: parsed.state,
      title: parsed.title,
      draft: parsed.draft,
      head: parsed.head.ref,
      base: parsed.base.ref,
    };
  }
  async createPullRequest(
    auth: LocalDeviceAuth,
    resourceId: string,
    generation: number,
    input: unknown,
  ) {
    const result = await this.pullRequestData(
      auth,
      resourceId,
      generation,
      "",
      createPullRequestSchema.parse(input),
    );
    return this.projectPullRequest(result.data, result.repository, true);
  }
  async getPullRequest(
    auth: LocalDeviceAuth,
    resourceId: string,
    generation: number,
    number: number,
  ) {
    const result = await this.pullRequestData(
      auth,
      resourceId,
      generation,
      `/${z.number().int().positive().parse(number)}`,
    );
    return this.projectPullRequest(result.data, result.repository);
  }
  async findPullRequests(
    auth: LocalDeviceAuth,
    resourceId: string,
    generation: number,
    input: unknown,
  ): Promise<GitHubPullRequest[]> {
    const query = findPullRequestsSchema.parse(input);
    const repository = this.dependencies.authorize(auth, resourceId, generation, "fetch");
    const parameters = new URLSearchParams({
      state: "open",
      head: `${repository.fullName.split("/")[0]}:${query.head}`,
      base: query.base,
      per_page: "100",
    });
    const result = await this.pullRequestData(auth, resourceId, generation, `?${parameters}`);
    const rows = z.array(z.unknown()).max(100).safeParse(result.data);
    if (!rows.success)
      throw new LocalDeviceError("LOCAL_CONFLICT", "GitHub returned an invalid pull request list.");
    return rows.data
      .map((row) => this.projectPullRequest(row, result.repository))
      .filter((pr) => pr.head === query.head && pr.base === query.base && pr.state === "open");
  }
}
