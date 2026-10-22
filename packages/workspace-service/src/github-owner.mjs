import { request } from "node:https";
import { Buffer } from "node:buffer";
import { pipeline } from "node:stream/promises";
import { URL, URLSearchParams } from "node:url";
import { connectHttps, transportClosed } from "./tls-transport.mjs";
import { z } from "zod";
import { gitBranchSchema } from "../../shared/src/codespaces/git-ref.ts";
import { scopedCredentialFailureOutcome } from "../../shared/src/codespaces/scoped-credential-types.ts";
import { WORKSPACE_REQUEST_ID_PATTERN } from "../../shared/src/codespaces/workspace-request-id.ts";
export { readOwnerJsonBody as readOwnerPullRequestInput } from "../../shared/src/http/request-body.mjs";

export class GitHubOwnerError extends Error {
  constructor(publicCode, status = 409) {
    super(
      scopedCredentialFailureOutcome(publicCode) === "unconfirmed"
        ? "The scoped credential outcome is unconfirmed. Collect its original security request."
        : publicCode === "WORKSPACE_OUTCOME_UNCONFIRMED"
          ? "The approved GitHub operation outcome is unconfirmed."
          : publicCode === "CODESPACE_PROVIDER_UNAVAILABLE"
            ? "The approved GitHub provider is unavailable."
            : "The approved GitHub operation was refused.",
    );
    this.publicCode = publicCode;
    this.status = status;
  }
}
const reject = (code = "CODESPACE_GITHUB_REJECTED", status) => {
  throw new GitHubOwnerError(code, status);
};
const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
export const createOwnerPullRequestSchema = z
  .object({
    head: gitBranchSchema,
    base: gitBranchSchema,
    title: z.string().trim().min(1),
    body: z.string().default(""),
    draft: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.head !== value.base);
const getSchema = z.object({ number: z.number().int().positive() }).strict();
const findSchema = z.object({ head: gitBranchSchema, base: gitBranchSchema }).strict();
export function validateOwnerPullRequestInput(action, input) {
  const schema =
    action === "pull_request_create"
      ? createOwnerPullRequestSchema
      : action === "pull_request_get"
        ? getSchema
        : action === "pull_request_find"
          ? findSchema
          : null;
  const parsed = schema?.safeParse(input);
  if (!parsed?.success) reject();
  return parsed.data;
}

async function withLease(authority, action, work) {
  if (!repositorySchema.safeParse(authority.repositoryFullName).success) reject();
  const lease = await authority.acquire(action, authority.signal);
  try {
    if (
      lease.repositoryFullName.toLowerCase() !== authority.repositoryFullName.toLowerCase() ||
      !(
        (lease.mode === "anonymous" && action === "fetch") ||
        (lease.mode === "scoped" &&
          typeof lease.token === "string" &&
          lease.token &&
          typeof lease.credentialId === "string" &&
          lease.credentialId &&
          typeof lease.validate === "function" &&
          Number.isSafeInteger(lease.expiresAt))
      ) ||
      (!(lease.mode === "anonymous" && lease.useUntil === null) &&
        (!Number.isSafeInteger(lease.useUntil) ||
          (lease.mode === "scoped" ? Math.min(lease.expiresAt, lease.useUntil) : lease.useUntil) <=
            Date.now()))
    )
      reject();
    const abort = new globalThis.AbortController();
    const stopped = () => abort.abort();
    authority.signal?.addEventListener("abort", stopped, { once: true });
    if (authority.signal?.aborted) stopped();
    const useUntil =
      lease.mode === "scoped" ? Math.min(lease.expiresAt, lease.useUntil) : lease.useUntil;
    const deadline =
      useUntil === null
        ? undefined
        : globalThis.setTimeout(stopped, Math.min(useUntil - Date.now(), 2147483647));
    deadline?.unref();
    const validation = new globalThis.AbortController();
    let checking;
    const sweep =
      lease.mode === "scoped"
        ? globalThis.setInterval(() => {
            if (checking || validation.signal.aborted) return;
            checking = lease
              .validate(validation.signal)
              .catch(stopped)
              .finally(() => {
                checking = undefined;
              });
          }, 2000)
        : null;
    sweep?.unref();
    try {
      return await work(lease, abort.signal);
    } finally {
      globalThis.clearTimeout(deadline);
      globalThis.clearInterval(sweep);
      validation.abort();
      await checking;
      authority.signal?.removeEventListener("abort", stopped);
    }
  } finally {
    await lease.dispose();
  }
}

async function outbound(hostname, path, method, headers, signal, consume) {
  const socket = await connectHttps({ hostname, publicTarget: true, signal });
  const closed = transportClosed(socket);
  let outgoing;
  let incoming;
  let sending;
  try {
    incoming = await new Promise((resolve, refuse) => {
      outgoing = request(
        {
          hostname,
          path,
          method,
          headers,
          signal,
          createConnection: () => socket,
          maxHeaderSize: 8192,
        },
        resolve,
      );
      outgoing.once("error", refuse);
      sending = Promise.resolve(consume.send(outgoing));
      void sending.catch(() => undefined);
    });
    if (incoming.statusCode >= 300 && incoming.statusCode < 400) reject();
    const result = await consume.receive(incoming);
    await sending;
    return result;
  } finally {
    incoming?.destroy();
    outgoing?.destroy();
    socket.destroy();
    await closed;
    await sending?.catch(() => undefined);
  }
}

/** Shared fixed smart-HTTP implementation. No provider token reaches Git's caller. */
export async function serveOwnerGit(incoming, response, authority) {
  const prefix = `/git/${authority.repositoryFullName}.git/`;
  const actions = {
    "info/refs?service=git-upload-pack": "fetch",
    "info/refs?service=git-receive-pack": "push",
    "git-upload-pack": "fetch",
    "git-receive-pack": "push",
  };
  const relative = incoming.url?.startsWith(prefix) ? incoming.url.slice(prefix.length) : "";
  const action = actions[relative];
  if (
    !action ||
    incoming.method !== (relative.startsWith("info/refs?") ? "GET" : "POST") ||
    (action === "push" && !authority.allowPush) ||
    incoming.headers.origin
  )
    reject();
  await withLease(authority, action, (lease, signal) =>
    outbound(
      "github.com",
      `/${authority.repositoryFullName}.git/${relative}`,
      incoming.method,
      {
        host: "github.com",
        "user-agent": "Moira-Owner-Git",
        accept: "*/*",
        ...(lease.mode === "anonymous"
          ? {}
          : {
              authorization: `Basic ${Buffer.from(`x-access-token:${lease.token}`).toString("base64")}`,
            }),
        ...(incoming.method === "POST"
          ? {
              "content-type": `application/x-git-${action === "push" ? "receive" : "upload"}-pack-request`,
            }
          : {}),
        ...(incoming.headers["git-protocol"] === "version=2"
          ? { "git-protocol": "version=2" }
          : {}),
      },
      signal,
      {
        send: (upstream) => {
          incoming.once("aborted", () => upstream.destroy());
          response.once("close", () => upstream.destroy());
          return pipeline(incoming, upstream);
        },
        receive: async (reply) => {
          response.writeHead(reply.statusCode ?? 502, {
            "content-type":
              typeof reply.headers["content-type"] === "string"
                ? reply.headers["content-type"]
                : "application/octet-stream",
            "cache-control": "no-store",
            connection: "close",
          });
          await pipeline(reply, response, { end: false });
        },
      },
    ),
  );
  // The terminal HTTP framing is confirmation: retain it until source transport
  // has physically closed and trusted child disposal has completed.
  response.end();
}

function projectPullRequest(data, repository) {
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
  if (!decoded.success) reject();
  const value = decoded.data;
  const url = new URL(value.html_url);
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.toLowerCase() !== `/${repository}/pull/${value.number}`.toLowerCase()
  )
    reject();
  return {
    number: value.number,
    url: value.html_url,
    state: value.state,
    title: value.title,
    head: value.head.ref,
    base: value.base.ref,
    draft: value.draft,
  };
}

/** Reuses the fixed PR schema/client/projection for host and guest trusted brokers. */
export async function ownerPullRequest(action, input, authority) {
  const create = action === "pull_request_create";
  const value = validateOwnerPullRequestInput(action, input);
  const repository = authority.repositoryFullName;
  const suffix = create
    ? ""
    : action === "pull_request_get"
      ? `/${value.number}`
      : `?${new URLSearchParams({ state: "open", head: `${repository.split("/")[0]}:${value.head}`, base: value.base, per_page: "100" })}`;
  let dispatched = false;
  try {
    return await withLease(
      authority,
      create ? "pull_request_create" : "pull_request_read",
      async (lease, signal) => {
        const data = await outbound(
          "api.github.com",
          `/repos/${repository}/pulls${suffix}`,
          create ? "POST" : "GET",
          {
            authorization: `Bearer ${lease.token}`,
            accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "user-agent": "Moira-Owner-Git",
            ...(create ? { "content-type": "application/json" } : {}),
          },
          signal,
          {
            send: (upstream) => {
              dispatched = true;
              upstream.end(create ? JSON.stringify(value) : undefined);
            },
            receive: async (reply) => {
              if (reply.statusCode < 200 || reply.statusCode >= 300) {
                if (create && reply.statusCode >= 500) reject("WORKSPACE_OUTCOME_UNCONFIRMED", 503);
                dispatched = false;
                reject();
              }
              const chunks = [];
              for await (const chunk of reply) chunks.push(chunk);
              return JSON.parse(Buffer.concat(chunks).toString("utf8"));
            },
          },
        );
        if (action === "pull_request_find") {
          if (!Array.isArray(data) || data.length > 100) reject();
          return data
            .map((row) => projectPullRequest(row, repository))
            .filter(
              (pr) => pr.head === value.head && pr.base === value.base && pr.state === "open",
            );
        }
        return projectPullRequest(data, repository);
      },
    );
  } catch (error) {
    if (create && dispatched)
      throw Object.assign(
        new GitHubOwnerError("WORKSPACE_OUTCOME_UNCONFIRMED", 503),
        error.securityRequestId ? { securityRequestId: error.securityRequestId } : {},
      );
    const securityRequestId = WORKSPACE_REQUEST_ID_PATTERN.test(error?.securityRequestId ?? "")
      ? error.securityRequestId
      : undefined;
    const issuerCode = error?.code ?? error?.publicCode;
    const securityOutcome = scopedCredentialFailureOutcome(issuerCode);
    if (
      !dispatched &&
      securityRequestId &&
      securityOutcome === null &&
      (error.outcome === "unconfirmed" ||
        ["WORKSPACE_OUTCOME_UNCONFIRMED", "WORKSPACE_OUTCOME_UNKNOWN"].includes(issuerCode))
    )
      throw Object.assign(new GitHubOwnerError("SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED", 503), {
        securityRequestId,
      });
    if (error instanceof GitHubOwnerError) throw error;
    if (securityOutcome !== null)
      throw Object.assign(
        new GitHubOwnerError(error.code, securityOutcome === "unconfirmed" ? 503 : 409),
        securityRequestId ? { securityRequestId } : {},
      );
    reject("CODESPACE_PROVIDER_UNAVAILABLE", 503);
  }
}
