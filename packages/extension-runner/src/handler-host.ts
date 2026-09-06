/**
 * The process that actually runs extension code.
 *
 * It is a separate process from the service on purpose: an extension that throws, hangs, exhausts
 * memory or calls `process.exit` must not take the HTTP service with it. The service treats this
 * process as disposable — it kills it on a deadline and starts a new one on the next call.
 *
 * Only this process imports the bundle entrypoint. Everything it may reach beyond its own code is
 * handed to it per invocation and checked against the manifest's permissions.
 */

import { pathToFileURL } from "url";
import type {
  ExtensionModule,
  ExtensionNodeDefinition,
  ExtensionNodeServices,
  JsonObject,
} from "@mcp-moira/extension-sdk";
import type { ExtensionManifest } from "@mcp-moira/workflow-engine/extensions/contract";
import { canonicalJson } from "@mcp-moira/workflow-engine/extensions";
import type { HostRequest, HostResponse, RunnerInvokeRequest } from "./protocol.js";

const entrypoint = process.env.MOIRA_EXTENSION_ENTRYPOINT;
const manifestJson = process.env.MOIRA_EXTENSION_MANIFEST;

function send(message: HostResponse): void {
  process.send?.(message);
}

function permissionError(what: string): Error {
  const error = new Error(
    `${what} is not granted to this extension; add it to the manifest permissions to use it`,
  );
  error.name = "ExtensionPermissionError";
  return error;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

/**
 * Services for one invocation. Each is either granted by the manifest or refuses by name: a handler
 * must be able to tell "I may not do this" from "there was nothing there".
 */
function createServices(
  manifest: ExtensionManifest,
  request: RunnerInvokeRequest,
  signal: AbortSignal,
  currentInvocationId: string,
): ExtensionNodeServices {
  const permissions = manifest.permissions ?? {};
  const allowedHosts = new Set((permissions.network ?? []).map((host) => host.toLowerCase()));
  const grantedSecrets = new Set(permissions.secrets ?? []);

  return {
    log(message, fields) {
      send({
        kind: "log",
        id: currentInvocationId,
        message,
        fields: fields as Record<string, unknown>,
      });
    },

    async fetch(url, init) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw new Error(`'${url}' is not a valid absolute URL`);
      }
      const redirectMode = init?.redirect ?? "follow";
      let requestInit: RequestInit = {
        ...init,
        redirect: "manual",
        signal: init?.signal ?? signal,
      };
      for (let redirects = 0; ; redirects += 1) {
        if (!allowedHosts.has(target.host.toLowerCase())) {
          throw permissionError(`network access to '${target.host}'`);
        }
        const response = await fetch(target, requestInit);
        const location = response.headers.get("location");
        if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
        if (redirectMode === "manual") return response;
        if (redirectMode === "error") {
          throw new TypeError("redirect encountered in redirect:error mode");
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(`HTTP request exceeded ${MAX_REDIRECTS} redirects`);
        }
        const previousOrigin = target.origin;
        target = new URL(location, target);
        const headers = new Headers(requestInit.headers);
        if (target.origin !== previousOrigin) {
          headers.delete("authorization");
          headers.delete("cookie");
          headers.delete("proxy-authorization");
        }
        const method = String(requestInit.method ?? "GET").toUpperCase();
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST")
        ) {
          headers.delete("content-length");
          headers.delete("content-type");
          headers.delete("transfer-encoding");
          requestInit = { ...requestInit, headers, method: "GET", body: undefined };
        } else {
          requestInit = { ...requestInit, headers };
        }
      }
    },

    async secret(alias) {
      if (!grantedSecrets.has(alias)) {
        throw permissionError(`secret '${alias}'`);
      }
      // A granted alias with no value returns null, which is a different situation from a refusal.
      return request.secrets?.[alias] ?? null;
    },

    async writeArtifact(name, content) {
      if (!permissions.artifacts) {
        throw permissionError("artifact writing");
      }
      // The size limit is not checked here. This process runs extension code, so a check made in
      // it protects only well-behaved extensions; the service enforces the limit where the memory
      // and the response actually are, and fails the whole call when it is exceeded.
      // The artifact travels with the call's result rather than through a channel of its own: a
      // handler process has no connection to Moira, and an out-of-band path would let an artifact
      // outlive a call that ultimately failed.
      send({ kind: "artifact", id: currentInvocationId, name, content });
    },
  };
}

/**
 * Reconcile what the bundle's code says with what its manifest declares.
 *
 * The manifest is the source of truth — Moira and the service both read schemas from it — so code
 * that restates a schema differently would leave the author looking at one declaration while the
 * system enforces another. Refusing here is the only place this can be seen at all: manifests are
 * checked before any extension code is imported, and this process is the one that imports it.
 */
function compareWithManifest(
  manifest: ExtensionManifest,
  definitions: Map<string, ExtensionNodeDefinition>,
): string[] {
  const problems: string[] = [];
  for (const declared of manifest.nodes) {
    const definition = definitions.get(declared.type);
    if (!definition) {
      problems.push(
        `the manifest declares node type '${declared.type}', but no handler implements it`,
      );
      continue;
    }
    for (const schema of ["configSchema", "inputSchema", "outputSchema"] as const) {
      const inCode = definition[schema];
      // Absent in code means "the manifest is the only declaration", which is the ordinary case.
      if (inCode === undefined) continue;
      if (canonicalJson(inCode ?? null) !== canonicalJson(declared[schema] ?? null)) {
        problems.push(
          `node type '${declared.type}' declares a different ${schema} in code than in the manifest`,
        );
      }
    }
  }

  return problems;
}

async function main(): Promise<void> {
  if (!entrypoint || !manifestJson) {
    send({
      kind: "load-failed",
      message: "handler host started without an entrypoint or manifest",
    });
    return;
  }

  const manifest = JSON.parse(manifestJson) as ExtensionManifest;

  let definitions: Map<string, ExtensionNodeDefinition>;
  try {
    const loaded = (await import(pathToFileURL(entrypoint).href)) as {
      default?: ExtensionModule;
      nodes?: ExtensionNodeDefinition[];
    };
    const nodes = loaded.default?.nodes ?? loaded.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) {
      send({
        kind: "load-failed",
        message: "entrypoint does not export a default extension with a 'nodes' array",
      });
      return;
    }
    definitions = new Map(nodes.map((node) => [node.type, node]));

    const disagreements = compareWithManifest(manifest, definitions);
    if (disagreements.length > 0) {
      send({ kind: "load-failed", message: disagreements.join("; ") });
      return;
    }
  } catch (error) {
    send({
      kind: "load-failed",
      message: `entrypoint failed to load: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  const inFlight = new Map<string, AbortController>();
  send({ kind: "ready", nodeTypes: [...definitions.keys()] });

  process.on("message", (raw: HostRequest) => {
    if (raw.kind === "cancel") {
      inFlight.get(raw.id)?.abort();
      return;
    }
    if (raw.kind !== "invoke") return;

    const { id, request } = raw;
    const definition = definitions.get(request.nodeType);
    if (!definition) {
      send({
        kind: "result",
        id,
        response: {
          ok: false,
          kind: "handler-error",
          message: `this extension does not implement node type '${request.nodeType}'`,
        },
      });
      return;
    }

    const controller = new AbortController();
    inFlight.set(id, controller);

    void definition
      .handler({
        config: (request.config ?? {}) as JsonObject,
        input: (request.input ?? {}) as JsonObject,
        executionId: request.executionId,
        nodeId: request.nodeId,
        signal: controller.signal,
        services: createServices(manifest, request, controller.signal, id),
      })
      .then((output) => {
        send({
          kind: "result",
          id,
          response: { ok: true, output: output as Record<string, unknown> },
        });
      })
      .catch((error: unknown) => {
        send({
          kind: "result",
          id,
          response: {
            ok: false,
            kind: "handler-error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      })
      .finally(() => {
        inFlight.delete(id);
      });
  });
}

void main();
