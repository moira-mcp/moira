/**
 * The extension runner service: the only thing Moira talks to when a custom node executes.
 *
 * It answers three questions — are you ready, what do you provide, run this node — and it owns the
 * handler processes that do the work. No extension code runs in this process, so a broken extension
 * changes what this service answers about itself but never whether it answers.
 */

import * as http from "http";
import Ajv, { type ValidateFunction } from "ajv";
import { scanExtensionBundles, type BundleScanResult } from "./bundle-loader.js";
import { ExtensionHost } from "./extension-host.js";
import {
  EXTENSION_RUNNER_API_VERSION,
  type RunnerChannelCheckRequest,
  type RunnerChannelDeliverRequest,
  type RunnerHealthResponse,
  type RunnerInvokeRequest,
  type RunnerInvokeResponse,
  type RunnerNodesResponse,
} from "./protocol.js";

export interface RunnerOptions {
  extensionsDir: string;
  port?: number;
  host?: string;
  maxConcurrentPerExtension?: number;
  maxQueuedPerExtension?: number;
  execArgv?: string[];
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface RunningRunner {
  port: number;
  close(): Promise<void>;
  /** Scan result, so an operator can see why a bundle was refused. */
  scan: BundleScanResult;
}

const MAX_BODY_BYTES = 1_000_000;
const MAX_COMMUNICATION_BODY_BYTES = 28 * 1024 * 1024;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validCommunicationDelivery(request: RunnerChannelDeliverRequest): boolean {
  if (!isPlainRecord(request.message) || typeof request.message.text !== "string") return false;
  if (
    request.message.format !== undefined &&
    !["plain", "markdown", "html"].includes(request.message.format)
  )
    return false;
  if (request.message.silent !== undefined && typeof request.message.silent !== "boolean")
    return false;
  if (request.settings !== undefined && !isPlainRecord(request.settings)) return false;
  if (request.secrets !== undefined) {
    if (!isPlainRecord(request.secrets)) return false;
    if (
      !Object.values(request.secrets).every((value) => value === null || typeof value === "string")
    )
      return false;
  }
  const attachment = request.message.attachment;
  if (!attachment) return true;
  if (
    !isPlainRecord(attachment) ||
    (attachment.kind !== "image" && attachment.kind !== "document") ||
    attachment.encoding !== "base64" ||
    typeof attachment.data !== "string" ||
    typeof attachment.filename !== "string" ||
    typeof attachment.mimeType !== "string" ||
    attachment.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data)
  )
    return false;
  return Buffer.from(attachment.data, "base64").toString("base64") === attachment.data;
}

export class ExtensionRunnerService {
  private hosts = new Map<string, ExtensionHost>();
  private hostByNodeType = new Map<string, ExtensionHost>();
  private hostByCommunicationChannelId = new Map<string, ExtensionHost>();
  private outputValidators = new Map<string, ValidateFunction>();
  // The same options Moira compiles declared schemas with: a schema's `$id` is never registered, so
  // two extensions carrying the same one do not make the second call fail for a reason that has
  // nothing to do with its result.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ajv = new (Ajv as any)({ allErrors: false, strict: false, addUsedSchema: false });
  readonly scan: BundleScanResult;

  constructor(private readonly options: RunnerOptions) {
    this.scan = scanExtensionBundles(options.extensionsDir);

    for (const bundle of this.scan.bundles) {
      const host = new ExtensionHost(bundle, {
        maxConcurrent: options.maxConcurrentPerExtension,
        maxQueued: options.maxQueuedPerExtension,
        execArgv: options.execArgv,
        onLog: (message, fields) => options.log?.(`[${bundle.manifest.name}] ${message}`, fields),
      });
      this.hosts.set(bundle.manifest.name, host);
      for (const type of host.nodeTypes) this.hostByNodeType.set(type, host);
      for (const id of host.communicationChannelIds) {
        this.hostByCommunicationChannelId.set(id, host);
      }
    }
  }

  health(): RunnerHealthResponse {
    return {
      apiVersion: EXTENSION_RUNNER_API_VERSION,
      ready: true,
      extensions: [...this.hosts.values()].map((host) => ({
        name: host.name,
        version: host.manifest.version,
        nodeTypes: host.nodeTypes,
        communicationChannelIds: host.communicationChannelIds,
        healthy: host.healthy,
      })),
      rejected: this.scan.rejected,
    };
  }

  nodes(): RunnerNodesResponse {
    return {
      apiVersion: EXTENSION_RUNNER_API_VERSION,
      extensions: [...this.hosts.values()].map((host) => ({
        name: host.name,
        version: host.manifest.version,
        entrypoint: host.manifest.entrypoint,
        nodes: host.manifest.nodes,
        communicationChannels: host.manifest.communicationChannels,
        settings: host.manifest.settings,
        permissions: host.manifest.permissions,
      })),
    };
  }

  async invoke(request: RunnerInvokeRequest, signal?: AbortSignal): Promise<RunnerInvokeResponse> {
    const host = this.hostByNodeType.get(request.nodeType);
    if (!host) {
      return {
        ok: false,
        kind: "handler-error",
        message: `no installed extension provides node type '${request.nodeType}'`,
      };
    }

    const response = await host.invoke(request, signal);
    if (!response.ok) return response;

    // The declared output schema is checked here as well as in Moira: a handler result that does
    // not match must never be presented as a result, and the service is the first place that can
    // say so about its own extension.
    const declaration = host.manifest.nodes.find((node) => node.type === request.nodeType);
    if (declaration?.outputSchema) {
      let validate = this.outputValidators.get(request.nodeType);
      if (typeof validate !== "function") {
        try {
          validate = this.ajv.compile(declaration.outputSchema);
        } catch (error) {
          // Moira refuses a manifest whose schema does not compile, so this is reachable only for a
          // caller that is not Moira. It stays a typed failure of the call: the service answers
          // about the extension rather than dying on it.
          return {
            ok: false,
            kind: "invalid-output",
            message: `declared outputSchema could not be compiled: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
        if (typeof validate !== "function") {
          return {
            ok: false,
            kind: "invalid-output",
            message: "declared outputSchema did not compile to a validator",
          };
        }
        this.outputValidators.set(request.nodeType, validate);
      }
      if (!validate(response.output)) {
        const errors = (validate.errors ?? [])
          .map((issue) => `${issue.instancePath || "/"} ${issue.message ?? "is invalid"}`)
          .join("; ");
        return {
          ok: false,
          kind: "invalid-output",
          message: `handler result does not match the declared outputSchema: ${errors}`,
        };
      }
    }

    return response;
  }

  async checkCommunicationChannel(
    request: RunnerChannelCheckRequest,
    signal?: AbortSignal,
  ): Promise<RunnerInvokeResponse> {
    const host = this.hostByCommunicationChannelId.get(request.channelId);
    if (!host) {
      return {
        ok: false,
        kind: "handler-error",
        message: `no installed extension provides communication channel '${request.channelId}'`,
      };
    }
    return host.invoke(
      {
        nodeType: "",
        nodeId: "",
        executionId: "",
        workflowId: "",
        config: {},
        timeoutMs: request.timeoutMs,
        communication: { kind: "check", channelId: request.channelId },
      },
      signal,
    );
  }

  async deliverCommunicationChannel(
    request: RunnerChannelDeliverRequest,
    signal?: AbortSignal,
  ): Promise<RunnerInvokeResponse> {
    const host = this.hostByCommunicationChannelId.get(request.channelId);
    if (!host) {
      return {
        ok: false,
        kind: "handler-error",
        message: `no installed extension provides communication channel '${request.channelId}'`,
      };
    }
    const declaration = host.manifest.communicationChannels?.find(
      (channel) => channel.id === request.channelId,
    );
    const settings = Object.fromEntries(
      (declaration?.settings ?? []).flatMap((key) =>
        request.settings && key in request.settings ? [[key, request.settings[key]]] : [],
      ),
    );
    const secrets = Object.fromEntries(
      (declaration?.permissions?.secrets ?? []).map((key) => [key, request.secrets?.[key] ?? null]),
    );
    return host.invoke(
      {
        nodeType: "",
        nodeId: "",
        executionId: "",
        workflowId: "",
        config: {},
        timeoutMs: request.timeoutMs,
        secrets,
        communication: {
          kind: "deliver",
          channelId: request.channelId,
          message: request.message,
          settings,
        },
      },
      signal,
    );
  }

  stopAll(): void {
    for (const host of this.hosts.values()) host.stop("service shutting down");
  }
}

function readBody(
  request: http.IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    request.on("error", reject);
  });
}

/** Start the service. Returns once it is listening. */
export async function startExtensionRunner(options: RunnerOptions): Promise<RunningRunner> {
  const service = new ExtensionRunnerService(options);

  const server = http.createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(payload);
    };

    const url = new URL(request.url ?? "/", "http://runner.local");

    if (request.method === "GET" && url.pathname === "/health") {
      send(200, service.health());
      return;
    }

    if (request.method === "GET" && url.pathname === "/nodes") {
      send(200, service.nodes());
      return;
    }

    if (request.method === "POST" && url.pathname === "/invoke") {
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      void readBody(request)
        .then(async (raw) => {
          let parsed: RunnerInvokeRequest;
          try {
            parsed = JSON.parse(raw) as RunnerInvokeRequest;
          } catch {
            send(400, { ok: false, kind: "handler-error", message: "request body is not JSON" });
            return;
          }
          const result = await service.invoke(parsed, controller.signal);
          // A failed invocation is still a complete answer: HTTP 200 with a typed failure keeps
          // "the extension failed" apart from "the service could not be reached".
          send(200, result);
        })
        .catch((error: unknown) => {
          send(400, {
            ok: false,
            kind: "handler-error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/channels/check" || url.pathname === "/channels/deliver")
    ) {
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      const maxBytes =
        url.pathname === "/channels/deliver" ? MAX_COMMUNICATION_BODY_BYTES : MAX_BODY_BYTES;
      void readBody(request, maxBytes)
        .then(async (raw) => {
          let parsed: RunnerChannelCheckRequest | RunnerChannelDeliverRequest;
          try {
            parsed = JSON.parse(raw) as RunnerChannelCheckRequest | RunnerChannelDeliverRequest;
          } catch {
            send(400, { ok: false, kind: "handler-error", message: "request body is not JSON" });
            return;
          }
          if (
            !parsed ||
            typeof parsed.channelId !== "string" ||
            !Number.isFinite(parsed.timeoutMs) ||
            parsed.timeoutMs <= 0
          ) {
            send(400, {
              ok: false,
              kind: "handler-error",
              message: "channelId and a positive timeoutMs are required",
            });
            return;
          }
          if (
            url.pathname === "/channels/deliver" &&
            !validCommunicationDelivery(parsed as RunnerChannelDeliverRequest)
          ) {
            send(400, {
              ok: false,
              kind: "handler-error",
              message: "communication delivery request is invalid",
            });
            return;
          }
          const result =
            url.pathname === "/channels/check"
              ? await service.checkCommunicationChannel(parsed, controller.signal)
              : await service.deliverCommunicationChannel(
                  parsed as RunnerChannelDeliverRequest,
                  controller.signal,
                );
          send(200, result);
        })
        .catch((error: unknown) => {
          send(400, {
            ok: false,
            kind: "handler-error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    send(404, { ok: false, kind: "handler-error", message: "unknown endpoint" });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "0.0.0.0", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);

  return {
    port,
    scan: service.scan,
    async close() {
      service.stopAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
