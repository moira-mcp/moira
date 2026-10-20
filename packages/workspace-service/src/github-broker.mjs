import { createServer, request as localRequest } from "node:http";
import { request } from "node:https";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { once } from "node:events";
import { connectHttps, transportClosed } from "./tls-transport.mjs";
import { ownerPullRequest, serveOwnerGit, GitHubOwnerError } from "./github-owner.mjs";
import { readOwnerJsonBody } from "./request-body.mjs";
import {
  scopedCredentialViewSchema,
  scopedCredentialCollectionSchema,
  scopedCredentialFailureOutcome,
} from "../../shared/src/codespaces/scoped-credential-types.ts";
import {
  prepareCredentialRequest,
  updateCredentialRequest,
  inspectCredentialRequest,
} from "./credential-request.mjs";
import { WORKSPACE_REQUEST_ID_PATTERN } from "../../shared/src/codespaces/workspace-request-id.ts";

async function metadata(origin, path, bearer, body, signal) {
  const target = new URL(origin);
  const socket = await connectHttps({
    hostname: target.hostname,
    port: Number(target.port || 443),
    signal,
  }).catch(() => {
    throw new GitHubOwnerError("CODESPACE_PROVIDER_UNAVAILABLE", 503);
  });
  const settled = transportClosed(socket);
  let outgoing, incoming;
  let submitted = false;
  try {
    incoming = await new Promise((resolve, reject) => {
      outgoing = request(
        {
          hostname: target.hostname,
          port: Number(target.port || 443),
          path,
          method: "POST",
          signal,
          createConnection: () => socket,
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        },
        resolve,
      );
      outgoing.once("error", reject);
      submitted = true;
      outgoing.end(JSON.stringify(body));
    });
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (incoming.statusCode !== 200) {
      const code = data.error?.code;
      throw new GitHubOwnerError(
        scopedCredentialFailureOutcome(code) !== null
          ? code
          : "SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED",
        incoming.statusCode,
      );
    }
    return data;
  } catch (error) {
    if (error instanceof GitHubOwnerError) throw error;
    throw new GitHubOwnerError(
      submitted ? "SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED" : "CODESPACE_PROVIDER_UNAVAILABLE",
      503,
    );
  } finally {
    incoming?.destroy();
    outgoing?.destroy();
    socket.destroy();
    await settled;
  }
}

export function workspaceGitAuthority(
  remote,
  repositoryFullName,
  store,
  verifyExclusiveOwner = async () => false,
) {
  const active = new Set();
  let currentRemote;
  let principal;
  const configureRemote = (next) => {
    if (next) {
      if (
        principal &&
        ["origin", "resourceId", "environmentIdentity"].some((key) => next[key] !== principal[key])
      )
        throw new GitHubOwnerError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
      principal ??= {
        origin: next.origin,
        resourceId: next.resourceId,
        environmentIdentity: next.environmentIdentity,
      };
    }
    currentRemote = next ? { ...next } : undefined;
  };
  const requireRemote = () => {
    if (!currentRemote) throw new GitHubOwnerError("SCOPED_CREDENTIAL_UNAVAILABLE", 503);
    return currentRemote;
  };
  const currentMetadata = (path, body, signal) => {
    const selected = requireRemote();
    return metadata(selected.origin, path, selected.credential, body, signal);
  };
  configureRemote(remote);
  const dispose = async (receipt, child) => {
    try {
      let publicationError;
      try {
        await updateCredentialRequest(
          store,
          receipt.requestId,
          "dispose_pending",
          child.credentialId,
        );
      } catch (error) {
        publicationError = error;
      }
      const released = await currentMetadata(
        `/api/codespaces/github/credentials/${child.credentialId}/release`,
        { resourceId: receipt.resourceId, resourceGeneration: receipt.resourceGeneration },
      );
      if (released.released !== true)
        throw Object.assign(new GitHubOwnerError("SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED", 503), {
          securityRequestId: receipt.requestId,
        });
      await updateCredentialRequest(store, receipt.requestId, "disposed", child.credentialId);
      if (publicationError) throw publicationError;
    } catch {
      throw Object.assign(new GitHubOwnerError("SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED", 503), {
        securityRequestId: receipt.requestId,
      });
    }
  };
  return {
    repositoryFullName,
    configureRemote,
    async collect(requestId) {
      const receipt = await inspectCredentialRequest(store, requestId);
      if (!receipt || active.has(requestId)) return receipt;
      if (receipt.resourceId !== requireRemote().resourceId)
        throw new GitHubOwnerError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
      const credentialId = receipt.credentialId;
      const input = {
        resourceId: receipt.resourceId,
        resourceGeneration: receipt.resourceGeneration,
        action: receipt.action,
        requestId: receipt.requestId,
      };
      const collection = scopedCredentialCollectionSchema.parse(
        await currentMetadata(`/api/codespaces/github/credentials/requests/${requestId}`, input),
      );
      if (collection.state === "live") {
        if (await verifyExclusiveOwner()) await dispose(receipt, collection.credential);
        else
          await updateCredentialRequest(
            store,
            requestId,
            "live",
            collection.credential.credentialId,
          );
      } else if (collection.state === "absent" && credentialId) {
        await updateCredentialRequest(store, requestId, "dispose_pending", credentialId);
      } else await updateCredentialRequest(store, requestId, collection.state);
      return inspectCredentialRequest(store, requestId);
    },
    async acquire(action, signal) {
      const selected = requireRemote();
      const binding = {
        resourceId: selected.resourceId,
        resourceGeneration: selected.resourceGeneration,
      };
      let preparingId;
      const receipt = await prepareCredentialRequest(
        {
          read: store.read,
          write: async (requestId, record) => {
            preparingId = requestId;
            active.add(requestId);
            await store.write(requestId, record);
          },
        },
        { ...binding, action },
      ).catch((error) => {
        if (preparingId) active.delete(preparingId);
        throw error;
      });
      const input = { ...binding, action, requestId: receipt.requestId };
      let result;
      try {
        result = await currentMetadata("/api/codespaces/github/credentials/acquire", input, signal);
      } catch (error) {
        const outcome = scopedCredentialFailureOutcome(error.publicCode);
        const unconfirmed =
          outcome === "unconfirmed" ||
          (outcome === null && error.publicCode !== "CODESPACE_PROVIDER_UNAVAILABLE");
        try {
          await updateCredentialRequest(
            store,
            receipt.requestId,
            unconfirmed ? "unconfirmed" : "refused",
          );
        } catch {
          throw Object.assign(new GitHubOwnerError("SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED", 503), {
            securityRequestId: receipt.requestId,
          });
        } finally {
          active.delete(receipt.requestId);
        }
        error.securityRequestId = receipt.requestId;
        throw error;
      }
      const parsed = scopedCredentialViewSchema.safeParse(result);
      if (!parsed.success) {
        try {
          if (
            typeof result?.credentialId === "string" &&
            /^[a-f0-9-]{36}$/.test(result.credentialId)
          )
            await dispose(receipt, result);
          else await updateCredentialRequest(store, receipt.requestId, "unconfirmed");
          throw Object.assign(new GitHubOwnerError("SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED", 503), {
            securityRequestId: receipt.requestId,
          });
        } finally {
          active.delete(receipt.requestId);
        }
      }
      try {
        await updateCredentialRequest(store, receipt.requestId, "live", result.credentialId);
      } catch {
        try {
          await dispose(receipt, result);
        } finally {
          active.delete(receipt.requestId);
        }
        throw Object.assign(new GitHubOwnerError("SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED", 503), {
          securityRequestId: receipt.requestId,
        });
      }
      return {
        mode: "scoped",
        token: result.token,
        credentialId: result.credentialId,
        expiresAt: result.expiresAt,
        useUntil: result.useUntil,
        repositoryFullName: result.repositoryFullName,
        validate: async (checkSignal) => {
          const collection = scopedCredentialCollectionSchema.parse(
            await currentMetadata(
              `/api/codespaces/github/credentials/requests/${receipt.requestId}`,
              input,
              checkSignal,
            ),
          );
          if (
            collection.state !== "live" ||
            collection.credential.credentialId !== result.credentialId ||
            collection.credential.token !== result.token ||
            collection.credential.repositoryFullName !== result.repositoryFullName ||
            collection.credential.expiresAt !== result.expiresAt ||
            collection.credential.useUntil !== result.useUntil
          )
            throw new GitHubOwnerError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
        },
        dispose: async () => {
          try {
            await dispose(receipt, result);
          } finally {
            active.delete(receipt.requestId);
          }
        },
      };
    },
  };
}

/** GH private broker is the same fixed Git/PR implementation used by the Local host. */
export async function startWorkspaceGitBroker(config, remote, store, verifyExclusiveOwner) {
  const abort = new globalThis.AbortController();
  const requests = new Set();
  const sockets = new Set();
  const authority = workspaceGitAuthority(
    remote,
    config.repositoryFullName,
    store,
    verifyExclusiveOwner,
  );
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 0, headersTimeout: 5000 },
    async (incoming, response) => {
      const work = (async () => {
        if (
          !incoming.headers.authorization &&
          !incoming.headers.origin &&
          incoming.url?.startsWith("/git/")
        ) {
          response.writeHead(401, {
            "www-authenticate": 'Basic realm="Moira Owner Git"',
            connection: "close",
          });
          response.end();
          return;
        }
        if (
          abort.signal.aborted ||
          incoming.headers.authorization !== config.authorization ||
          incoming.headers.origin
        )
          throw new GitHubOwnerError("CODESPACE_GITHUB_REJECTED", 403);
        if (incoming.url?.startsWith("/git/")) {
          await serveOwnerGit(incoming, response, {
            ...authority,
            allowPush: true,
            signal: abort.signal,
          });
          return;
        }
        const action = incoming.url?.slice("/github/".length);
        if (
          incoming.method !== "POST" ||
          !incoming.url?.startsWith("/github/") ||
          !["pull_request_create", "pull_request_get", "pull_request_find"].includes(action)
        )
          throw new GitHubOwnerError("CODESPACE_GITHUB_REJECTED", 403);
        const result = await ownerPullRequest(action, await readOwnerJsonBody(incoming), {
          ...authority,
          signal: abort.signal,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            action === "pull_request_find" ? { pull_requests: result } : { pull_request: result },
          ),
        );
      })();
      requests.add(work);
      try {
        await work;
      } catch (error) {
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(error instanceof GitHubOwnerError ? error.status : 409, {
            "content-type": "application/json",
          });
          response.end(
            JSON.stringify({
              error: {
                code:
                  error instanceof GitHubOwnerError
                    ? error.publicCode
                    : "CODESPACE_GITHUB_REJECTED",
                ...(WORKSPACE_REQUEST_ID_PATTERN.test(error.securityRequestId ?? "")
                  ? { security_request_id: error.securityRequestId }
                  : {}),
              },
            }),
          );
        }
      } finally {
        requests.delete(work);
      }
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(3437, "127.0.0.1");
  await once(server, "listening");
  let closing;
  return {
    collect: authority.collect,
    configureRemote: authority.configureRemote,
    close: () =>
      (closing ??= (async () => {
        abort.abort();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        await Promise.allSettled([...requests]);
      })()),
  };
}

/** Local guests send only an existing resource Basic capability to the host's fixed route. */
export function brokerPullRequest(proxy, action, input) {
  const target = new URL(proxy);
  return new Promise((resolve, reject) => {
    let connected = false;
    const outgoing = localRequest(
      {
        hostname: "127.0.0.1",
        port: 3437,
        method: "POST",
        agent: false,
        path: `/github/${action}`,
        headers: {
          authorization: `Basic ${Buffer.from(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`).toString("base64")}`,
          "content-type": "application/json",
        },
      },
      (reply) => {
        void (async () => {
          const chunks = [];
          for await (const chunk of reply) chunks.push(chunk);
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (reply.statusCode !== 200)
            throw Object.assign(
              new GitHubOwnerError(
                data.error?.code ?? "CODESPACE_PROVIDER_UNAVAILABLE",
                reply.statusCode,
              ),
              WORKSPACE_REQUEST_ID_PATTERN.test(data.error?.security_request_id ?? "")
                ? { securityRequestId: data.error.security_request_id }
                : {},
            );
          resolve(data);
        })().catch(reject);
      },
    );
    outgoing.once("socket", (socket) => {
      if (!socket.connecting && socket.remoteAddress !== undefined) connected = true;
      socket.once("connect", () => {
        connected = true;
      });
    });
    outgoing.once("error", () =>
      reject(
        new GitHubOwnerError(
          action === "pull_request_create" && connected
            ? "WORKSPACE_OUTCOME_UNCONFIRMED"
            : "CODESPACE_PROVIDER_UNAVAILABLE",
          503,
        ),
      ),
    );
    outgoing.end(JSON.stringify(input));
  });
}
