import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, realpath, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  CodespaceTransferService,
  CodespaceTransferRepository,
  localRepositoryTargetId,
  projectCodespaceSummary,
  localCodespaceFailureGuidance,
  type CodespaceResourcePolicy,
  type CodespaceResourceRecord,
  type LocalRelayAcknowledgement,
} from "@mcp-moira/shared";
import { createLocalCodespaceServices } from "../../packages/web-backend/src/services/local-codespace-services.js";
import {
  createLocalDeviceRoutes,
  createLocalDeviceManagementRoutes,
  createLocalDeviceBinaryRoutes,
} from "../../packages/web-backend/src/routes/local-devices.js";
import { PrivateState } from "../../packages/local/src/private-state.js";
import { LocalManager } from "../../packages/local/src/manager.js";
import { LocalRelay } from "../../packages/local/src/relay.js";
import { LocalRpc } from "../../packages/local/src/rpc.js";
import { LocalWebControl } from "../../packages/local/src/web-control.js";
import { SbxRuntime, type SandboxObservation } from "../../packages/local/src/sbx-runtime.js";
import type { LocalVmIdentity as SandboxIdentity } from "../../packages/local/src/local-vm-runtime.js";
import { adaptSbxRuntime } from "../../packages/local/src/local-vm-runtime-factory.js";
import { LocalRefusal, requireLocalGrant } from "../../packages/local/src/policy.js";
import { localFixture } from "./local/fixtures.js";
import {
  LocalCodespaceJobTransport,
  localCodespaceCredential,
} from "../../packages/web-backend/src/services/local-codespace-provider.js";
import { LocalCodespaceRelay } from "../../packages/web-backend/src/services/local-codespace-relay.js";

let root: string, sqlite: Database.Database;
let fixtureCleanups: (() => Promise<void>)[];
beforeEach(async () => {
  fixtureCleanups = [];
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-local-provider-")));
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys=ON");
  migrate(drizzle(sqlite), { migrationsFolder: resolve("packages/web-backend/drizzle") });
  for (const id of ["user-a", "user-b"])
    sqlite
      .prepare(
        `INSERT INTO user(id,email,handle,createdAt,updatedAt,approvedAt,emailVerified)
    VALUES(?,?,?,'before','before','approved',1)`,
      )
      .run(id, `${id}@example.test`, id);
});
afterEach(async () => {
  for (const cleanup of fixtureCleanups.reverse()) await cleanup();
  sqlite.close();
  await rm(root, { recursive: true, force: true });
});
const boundaryBytes = Buffer.from("controlled external-runtime boundary");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture(partLimit = 4 * 1024 * 1024, maxObjects = 512, nativeSize = 5) {
  const clock = { now: Date.now() };
  const state = await PrivateState.open(join(root, "companion"));
  const local = await localFixture(state);
  local.policy.leaseUntil = Date.now() + 3600_000;
  local.policy.repositories[0].allowDelete = true;
  await state.write("policy.json", local.policy);
  await state.remove(`space-${local.space.id}.json`);
  const guestRoot = join(root, "controlled-runtime");
  await mkdir(guestRoot, { mode: 0o700 });
  const policy: CodespaceResourcePolicy = {
    enabled: true,
    maxCpuCores: 4,
    maxMemoryBytes: 8 * 1024 ** 3,
    maxStorageBytes: 64 * 1024 ** 3,
    maxActivePerUser: 8,
    maxActiveGlobal: 16,
    createThrottleMs: 0,
    startWaitMs: 1000,
    createDeadlineMs: 60_000,
    cleanupDeadlineMs: 60_000,
    claimLeaseMs: 30_000,
    reconcileIntervalMs: 30_000,
    maxOperationMs: 10_000,
    maxOperationStdoutBytes: 1024,
    maxOperationStderrBytes: 1024,
    maxRetainedOutputBytes: 1024 * 1024,
    maxTransferFileBytes: partLimit,
    maxTransferObjectsPerUser: maxObjects,
  };
  const nativeBytes = Buffer.alloc(nativeSize),
    pattern = [0, 255, 65, 10, 128];
  for (let index = 0; index < nativeBytes.length; index++)
    nativeBytes[index] = pattern[index % pattern.length];
  const transfer = new CodespaceTransferService({
    repository: new CodespaceTransferRepository(sqlite),
    root: join(root, "private-transfers"),
    policy: () => policy,
    now: () => clock.now,
  });
  const services = createLocalCodespaceServices(transfer, {
    sqlite,
    now: () => clock.now,
    policy: () => policy,
    settingsUrl: "https://moira.example/app/settings",
    resourceAudit: () => undefined,
    operationAudit: () => undefined,
    nativeFetcher: {
      fetch: async () => ({
        contentLength: nativeBytes.length,
        mimeType: "application/octet-stream",
        body: (async function* () {
          yield nativeBytes;
        })(),
      }),
    },
  });
  const app = express();
  const server = createServer(app);
  const deliveryAbort = new AbortController();
  const fixtureId = randomUUID();
  const serverResponses = new Map<string, { status: number; contentType: string | null }>();
  app.use((req, res, next) => {
    res.setHeader("X-Moira-Fixture", fixtureId);
    res.once("finish", () => {
      serverResponses.set(String(req.get("X-Moira-Fixture-Request") ?? "management"), {
        status: res.statusCode,
        contentType: String(res.getHeader("Content-Type") ?? "absent"),
      });
    });
    next();
  });
  app.use(
    "/api/local-devices",
    createLocalDeviceBinaryRoutes(services.devices, transfer, "https://moira.example"),
  );
  app.use(
    "/api/local-devices",
    createLocalDeviceRoutes(services.devices, transfer, "https://moira.example"),
  );
  app.use(
    "/api/integrations/local",
    (req, _res, next) => {
      Object.assign(req, { userId: "user-a" });
      next();
    },
    createLocalDeviceManagementRoutes(services.devices, "https://moira.example"),
  );
  const faults = {
    dropNextAck: false,
    lostAcknowledgements: 0,
    holdOperations: false,
    detachExecution: false,
    createRefusal: null as string | null,
    removeRefusal: null as string | null,
    beforeAck: null as ((requestId: string) => Promise<void>) | null,
    afterAck: null as ((requestId: string) => Promise<void>) | null,
    afterCreateAdmitted: null as (() => Promise<void>) | null,
    beforeCreateReady: null as (() => Promise<void>) | null,
  };
  const removal = { completed: 0 };
  const physical = new Map<string, SandboxObservation["status"]>();
  const lifecycle = { stopSettles: true, stopEffects: 0, unknown: false };
  const unknownSpaces = new Set<string>();
  const guestActions: string[] = [];
  const retainedResults = new Map<string, unknown>();
  let transportRefusal:
    | {
        status: number;
        code: string;
        route: string;
        reason: string;
        shape: string;
        authority: string;
      }
    | undefined;
  const fetch: typeof globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://moira.example");
    options?.signal?.throwIfAborted();
    const requestTrace = randomUUID();
    let call =
      options?.method === "POST"
        ? request(server).post(url.pathname + url.search)
        : request(server).get(url.pathname + url.search);
    call = call.set("X-Moira-Fixture-Request", requestTrace);
    new Headers(options?.headers).forEach((value, key) => {
      call = call.set(key, value);
    });
    if (options?.body !== undefined && options.body !== null) {
      if (typeof options.body === "string") call = call.send(options.body);
      else if (options.body instanceof Uint8Array) call = call.send(Buffer.from(options.body));
      else throw new Error("Unexpected controlled request body");
    }
    const ack =
      url.pathname === "/api/local-devices/relay/ack" && typeof options?.body === "string"
        ? (JSON.parse(options.body) as LocalRelayAcknowledgement)
        : null;
    if (ack) await faults.beforeAck?.(ack.requestId);
    const response = await call.catch((cause: unknown) => {
      const error = cause as { code?: unknown };
      const code =
        typeof error.code === "string" && /^[A-Z_]+$/.test(error.code) ? error.code : "UNKNOWN";
      throw new Error(
        `Fixture loopback failed before HTTP response: code=${code};server_listening=${server.listening};app_finished=${serverResponses.has(requestTrace)};route=${ack ? "relay-ack" : url.pathname.endsWith("/result-part") ? "relay-result-part" : "local-device"}`,
        { cause },
      );
    });
    if (ack && response.status === 200) await faults.afterAck?.(ack.requestId);
    if (response.status >= 400) {
      const serialized =
        typeof response.text === "string"
          ? response.text
          : Buffer.isBuffer(response.body)
            ? response.body.toString("utf8")
            : null;
      let body: unknown = response.body;
      if (serialized)
        try {
          body = JSON.parse(serialized);
        } catch {
          body = null;
        }
      const envelope = body as {
        success?: unknown;
        error?: { code?: unknown; message?: unknown };
      } | null;
      const code: unknown = envelope?.error?.code;
      const message: unknown = envelope?.error?.message;
      const safeReasons = new Set([
        "Relay resource authority changed.",
        "Relay ownership denied.",
        "Private payload ownership denied.",
        "Result part belongs to another relay claim.",
        "Device generation is no longer active.",
        "Relay claim ownership denied.",
        "Relay work lease expired.",
        "Device access denied.",
        "Account access is required.",
        "Relay claim expired.",
      ]);
      let authority = "not_payload_request";
      const requestId =
        url.pathname.match(
          /^\/api\/local-devices\/relay\/([a-f0-9-]{36})\/(?:result-part|payload\/\d+)$/,
        )?.[1] ?? ack?.requestId;
      if (response.status === 401 && requestId) {
        const saved = services.devices.getRequest("user-a", requestId);
        if (saved) {
          try {
            const authorize = url.pathname.includes("/payload/")
              ? services.devices.authorizePayload.bind(services.devices)
              : services.devices.authorizeResult.bind(services.devices);
            authorize(
              saved,
              requestId,
              ack?.claimId ?? new Headers(options?.headers).get("X-Moira-Claim-Id")!,
            );
            authority = "payload_authority_current";
          } catch (error) {
            const refusal = error as { code?: unknown; message?: unknown };
            authority =
              typeof refusal.code === "string" && /^[A-Z_]{1,80}$/.test(refusal.code)
                ? refusal.code
                : "unclassified_authority";
            if (typeof refusal.message === "string" && safeReasons.has(refusal.message))
              authority += `:${refusal.message}`;
          }
          const resource = services.resource.getCodespace("user-a", saved.resourceId);
          authority += `;generation_matches=${resource.generation === saved.resourceGeneration};resource_state=${resource.state};delivery_live=${saved.deadlineAt > clock.now}`;
          const receipt = sqlite
            .prepare(
              "SELECT status,claimId,claimExpiresAt,deadlineAt FROM codespaceLocalRelay WHERE requestId=?",
            )
            .get(requestId) as {
            status: string;
            claimId: string;
            claimExpiresAt: number;
            deadlineAt: number;
          };
          authority += `;relay_status=${receipt.status};claim_matches=${receipt.claimId === (ack?.claimId ?? new Headers(options?.headers).get("X-Moira-Claim-Id"))};claim_live=${receipt.claimExpiresAt > clock.now}`;
        } else authority = "retained_request_missing";
      }
      const served = serverResponses.get(requestTrace);
      authority += `;fixture_header_matches=${response.headers["x-moira-fixture"] === fixtureId};server_status=${served?.status ?? "unseen"};server_content_type=${served?.contentType ?? "unseen"}`;
      transportRefusal = {
        status: response.status,
        code: typeof code === "string" && /^[A-Z_]{1,80}$/.test(code) ? code : "NO_SAFE_CODE",
        route: url.pathname.includes("/payload/")
          ? "relay-payload"
          : url.pathname.endsWith("/result-part")
            ? "relay-result-part"
            : url.pathname.endsWith("/ack")
              ? "relay-ack"
              : "device-management",
        reason:
          typeof message === "string" && safeReasons.has(message)
            ? message
            : "UNCLASSIFIED_REFUSAL",
        shape: `${String(response.headers["content-type"])};parsed=${body === null ? "non_json" : typeof body};success=${envelope?.success === false};error=${typeof envelope?.error};code=${typeof code}`,
        authority,
      };
    }
    if (url.pathname === "/api/local-devices/relay/ack" && faults.dropNextAck) {
      expect(response.status).toBe(200);
      faults.dropNextAck = false;
      faults.lostAcknowledgements++;
      throw new Error("Controlled lost acknowledgement response");
    }
    const bytes = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.text);
    return new Response(Uint8Array.from(bytes), {
      status: response.status,
      headers: { "content-type": String(response.headers["content-type"] ?? "application/json") },
    });
  };
  class ExternalRuntime extends SbxRuntime {
    override async stop(identity: SandboxIdentity) {
      const owned = (await local.records.list()).find(
        (space) => space.name === identity.name && space.runtimeId === identity.runtimeId,
      );
      if (!owned)
        throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "Controlled runtime identity changed.");
      lifecycle.stopEffects++;
      if (lifecycle.stopSettles) physical.set(owned.id, "stopped");
    }
    override async remove(identity: SandboxIdentity) {
      const owned = (await local.records.list()).find(
        (space) => space.name === identity.name && space.runtimeId === identity.runtimeId,
      );
      if (!owned)
        throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "Controlled runtime identity changed.");
      if (faults.removeRefusal)
        throw new LocalRefusal(faults.removeRefusal, "Controlled confirmed runtime refusal.");
      physical.delete(owned.id);
      removal.completed++;
    }
    override async verifySettings() {}
    override async verifyBoundary() {}
    override async networkPolicy() {
      return boundaryBytes;
    }
    override async list(): Promise<SandboxObservation[]> {
      return (await local.records.list())
        .filter(
          (space) =>
            space.phase !== "deleted" && space.runtimeId !== null && physical.has(space.id),
        )
        .map((space) => ({
          id: space.runtimeId!,
          name: space.name,
          agent: "shell",
          status: physical.get(space.id) ?? "error",
          workspaces: [],
          ports: [],
        }));
    }
    override async exact(identity: SandboxIdentity): Promise<SandboxObservation | null> {
      return (
        (await this.list()).find(
          (space) => space.name === identity.name && space.id === identity.runtimeId,
        ) ?? null
      );
    }
    override async guest(_identity: SandboxIdentity, argv: readonly string[], input?: Uint8Array) {
      expect(argv).toEqual(["node", "/tmp/moira-local-runtime/worker.mjs"]);
      const envelope = JSON.parse(Buffer.from(input!).toString("utf8"));
      expect(envelope.kind).toBe("operation");
      const job = envelope.request as Record<string, unknown>;
      guestActions.push(String(job.action));
      let result: unknown;
      if (job.action === "execute") {
        await state.write(`effect-${job.remoteMarker}.json`, { argv: job.argv, stdin: job.stdin });
        const stdout = Buffer.from(
          Array.isArray(job.argv) && job.argv[0] === "echo"
            ? String(job.argv[1])
            : "controlled guest result",
        );
        result = {
          state: "succeeded",
          stdoutBase64: stdout.toString("base64"),
          stderrBase64: "",
          stdoutBytes: stdout.length,
          stderrBytes: 0,
          exitCode: 0,
          outputLimitExceeded: false,
          sessionCaptureDropped: false,
        };
      } else if (job.action === "file-execute") {
        const file = job.request as {
          action: string;
          path: string;
          bytesBase64?: string;
          offset?: number;
          length?: number;
        };
        if (file.action === "upload") {
          const bytes = Buffer.from(file.bytesBase64!, "base64");
          await writeFile(join(guestRoot, "payload.bin"), bytes, { mode: 0o600 });
          result = {
            state: "succeeded",
            value: {
              action: "upload",
              path: file.path,
              previous: null,
              current: { size: bytes.length, sha256: hash(bytes), modifiedAt: Date.now() },
            },
          };
        } else if (file.action === "read") {
          const bytes = await readFile(join(guestRoot, "payload.bin"));
          result = {
            state: "succeeded",
            value: {
              action: "read",
              path: file.path,
              offset: file.offset,
              totalSize: bytes.length,
              bytesBase64: bytes
                .subarray(file.offset!, file.offset! + file.length!)
                .toString("base64"),
              sha256: hash(bytes),
            },
          };
        } else throw new Error("Unexpected controlled file request");
      } else if (job.action === "inspect") {
        result = faults.holdOperations
          ? { state: "running" }
          : (retainedResults.get(String(job.remoteMarker)) ?? { state: "absent" });
      } else if (job.action === "cancel") {
        result = faults.holdOperations ? { state: "running" } : { state: "absent" };
      } else if (job.action === "file-inspect") {
        result = faults.holdOperations
          ? { state: "running" }
          : (retainedResults.get(String(job.remoteMarker)) ?? { state: "absent" });
      } else if (job.action === "finalize") result = { state: "absent" };
      else throw new Error("Unexpected controlled operation request");
      if (job.action === "execute" || job.action === "file-execute") {
        retainedResults.set(String(job.remoteMarker), result);
        if (faults.holdOperations || (faults.detachExecution && job.action === "execute"))
          result = { state: "running" };
      }
      return Buffer.from(JSON.stringify({ ok: true, result }));
    }
  }
  const runtime = new ExternalRuntime(local.policy);
  const manager = new LocalManager(local.records, {
    runtime: () => adaptSbxRuntime(runtime),
    storage: async () => undefined,
    guard: async () => ({
      active: true,
      stop: async () => {},
      observe: () => runtime.list(),
      retire: async () => {},
      remove: async () => {},
      space: async (id, activate = false) => {
        const admission = await local.records.get(id);
        if (activate && admission && admission.desiredState !== "running")
          await local.records.put({
            ...admission,
            desiredState: "running",
            generation: admission.generation + 1,
          });
        return {
          active: true,
          prepare: async () => {
            const admitted = await local.records.get(id);
            if (!admitted?.runtimeId) throw new Error("Controlled sandbox absent");
            physical.set(id, "running");
            await local.records.put({
              ...admitted,
              phase: "usable",
              failure: null,
              lastStartedAt: Date.now(),
            });
          },
          validate: async () => {},
          operation: async (job) => {
            const space = await local.records.get(id);
            if (!space?.runtimeId) throw new Error("Controlled sandbox absent");
            return runtime.guest(
              { name: space.name, runtimeId: space.runtimeId },
              ["node", "/tmp/moira-local-runtime/worker.mjs"],
              Buffer.from(JSON.stringify({ kind: "operation", request: job })),
            );
          },
          stop: async () => {
            const space = await local.records.get(id);
            if (space) {
              lifecycle.stopEffects++;
              if (lifecycle.stopSettles) physical.set(id, "stopped");
              await local.records.put({
                ...space,
                desiredState: "stopped",
                phase: "stopped",
                generation: space.generation + 1,
              });
            }
          },
        };
      },
    }),
  });
  // Substitute only external startup. SQL/provider/relay/RPC/journals and operation admission remain actual code.
  manager.create = async (repositoryId, ref, operationMarker, onAdmitted) => {
    if (faults.createRefusal)
      throw new LocalRefusal(faults.createRefusal, "Controlled pre-native creation refusal.");
    requireLocalGrant(await local.records.policy(), repositoryId, Date.now());
    const existing = (await local.records.list()).find(
      (space) => space.operationMarker === operationMarker,
    );
    if (existing) return existing;
    const id = randomUUID();
    const space = {
      ...local.space,
      id,
      name: `moira-${id.replaceAll("-", "")}`,
      runtimeId: `controlled-${id}`,
      repositoryId,
      ref,
      operationMarker,
      createdAt: Date.now(),
      lastStartedAt: faults.beforeCreateReady ? null : Date.now(),
      networkPolicy: hash(boundaryBytes),
      phase: faults.beforeCreateReady ? ("creating" as const) : local.space.phase,
    };
    await local.records.put(space);
    physical.set(id, "running");
    onAdmitted?.();
    if (faults.beforeCreateReady) {
      await faults.beforeCreateReady();
      space.phase = "usable";
      space.lastStartedAt = Date.now();
      await local.records.put(space);
    }
    await faults.afterCreateAdmitted?.();
    return space;
  };
  const snapshot = manager.snapshot.bind(manager);
  manager.snapshot = async (spaceId?: string, ownerCleanup = false) => {
    const result = await snapshot(spaceId, ownerCleanup);
    return {
      ...result,
      spaces: result.spaces.map((space) => ({
        ...space,
        state:
          (lifecycle.unknown || unknownSpaces.has(space.id)) && space.state !== "absent"
            ? ("unknown" as const)
            : space.state,
      })),
    };
  };
  const rpc = new LocalRpc(manager),
    relay = new LocalRelay(local.records, fetch);
  fixtureCleanups.push(async () => {
    deliveryAbort.abort();
    await relay.drain();
    await manager.close();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const pairResponse = await request(server).post("/api/integrations/local/pairings").send({});
  expect(pairResponse.status).toBe(201);
  const pairing = pairResponse.body.data;
  try {
    expect(
      await relay.enroll("https://moira.example", pairing.pairingId, pairing.pairingToken),
    ).toMatchObject({ status: "pending" });
    const pending = services.devices.pairingStatus({
      pairingId: pairing.pairingId,
      pairingToken: pairing.pairingToken,
    });
    const confirmed = await request(server)
      .post(`/api/integrations/local/pairings/${pairing.pairingId}/confirm`)
      .send({ expectedRevision: pending.pairing.revision });
    expect(confirmed.status).toBe(200);
    await relay.confirmed();
  } catch (cause) {
    throw new Error(
      `Fixture connection setup refused: HTTP ${transportRefusal?.status ?? "UNKNOWN"}, code ${transportRefusal?.code ?? "UNKNOWN"}`,
      { cause },
    );
  }
  const drive = async <T>(work: Promise<T>, background = false): Promise<T> => {
    let settled = false;
    const outcome = work.then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    while (!settled) {
      const pending = sqlite
        .prepare("SELECT COUNT(*) count FROM codespaceLocalRelay WHERE status='queued'")
        .get() as { count: number };
      if (pending.count) {
        const refusalBeforePoll = transportRefusal;
        try {
          await relay.poll(rpc, deliveryAbort.signal, background);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "Controlled lost acknowledgement response"
          )
            if (
              error instanceof LocalRefusal &&
              (error.code === "LOCAL_UNAUTHORIZED" || error.code === "LOCAL_RELAY_REFUSED") &&
              transportRefusal &&
              transportRefusal !== refusalBeforePoll
            )
              throw new Error(
                `Fixture relay refused: ${transportRefusal.route}, HTTP ${transportRefusal.status}, code ${transportRefusal.code}, reason ${transportRefusal.reason}, shape ${transportRefusal.shape}, authority ${transportRefusal.authority}`,
                { cause: error },
              );
            else throw error;
        }
      } else await delay(5);
    }
    const result = await outcome;
    if ("error" in result) throw result.error;
    return result.value;
  };
  return {
    local,
    services,
    relay,
    rpc,
    manager,
    state,
    app,
    drive,
    nativeBytes,
    guestRoot,
    faults,
    removal,
    physical,
    lifecycle,
    unknownSpaces,
    localSpaceId: async (resource: CodespaceResourceRecord) => {
      const space = (await local.records.list()).find(
        (candidate) => candidate.operationMarker === resource.operationMarker,
      );
      if (!space) throw new Error("Controlled resource manifest is absent");
      return space.id;
    },
    clock,
    policy,
    guestActions,
    target: localRepositoryTargetId(local.policy.deviceId, local.policy.repositories[0].id),
  };
}

describe("actual local-only service composition and outbound relay", () => {
  test.each([false, true])(
    "an owner deletes an exact VM with agent deletion denied and work disabled (old refused intent=%s), without changing grants",
    async (oldRefusal) => {
      const actual = await fixture();
      const created = await actual.drive(
        actual.services.resource.create("user-a", actual.target, "main"),
      );
      const peer = await actual.drive(
        actual.services.resource.create("user-a", actual.target, "main"),
      );
      actual.local.policy.repositories[0].allowDelete = false;
      await actual.state.write("policy.json", actual.local.policy);
      if (!oldRefusal) await actual.relay.confirmed();
      let before = actual.services.resource.getCodespace("user-a", created.resource.id);
      await expect(
        oldRefusal
          ? actual.drive(
              actual.services.resource.deleteCodespace("user-a", before.id, before.generation),
            )
          : actual.services.resource.deleteCodespace("user-a", before.id, before.generation),
      ).rejects.toMatchObject({ code: "CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED" });
      if (oldRefusal) {
        before = actual.services.resource.getCodespace("user-a", before.id);
        expect(before).toMatchObject({
          state: "delete_pending",
          lastOutcome: "refused:CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED",
        });
      } else expect(actual.services.resource.getCodespace("user-a", before.id)).toEqual(before);
      const connection = (await actual.state.read("connection.json", (value) => value)) as {
        origin: string;
        userId: string;
        deviceId: string;
        deviceGeneration: number;
        connectionId: string;
      };
      await new LocalWebControl(actual.local.records).optIn(
        connection,
        {
          cpuCores: 32,
          memoryBytes: 64 * 1024 ** 3,
          storageBytes: 1024 * 1024 ** 3,
          dockerBytes: 128 * 1024 ** 3,
          maxLeaseMs: 7 * 24 * 3600_000,
        },
        true,
      );
      actual.local.policy.enabled = false;
      actual.local.policy.leaseUntil = Date.now() - 1;
      await actual.state.write("policy.json", actual.local.policy);
      await actual.relay.confirmed();
      const storedPolicy = await actual.state.read("policy.json", (value) => value);
      if (oldRefusal)
        sqlite
          .prepare(
            "DELETE FROM codespaceConnectionRepository WHERE connectionId=? AND externalRepositoryId=?",
          )
          .run(before.connectionId, actual.target);
      const removed = await actual.drive(
        actual.services.resource.deleteCodespace("user-a", before.id, before.generation, {
          ownerConfirmed: true,
        }),
      );
      expect(removed).toMatchObject({ state: "deleted", observedState: "absent" });
      expect(actual.removal.completed).toBe(1);
      expect(await actual.state.read("policy.json", (value) => value)).toEqual(storedPolicy);
      expect(actual.physical.get(await actual.localSpaceId(peer.resource))).toBe("running");
      expect(actual.services.resource.getCodespace("user-a", peer.resource.id)).toEqual(
        peer.resource,
      );
      const mutation = sqlite
        .prepare("SELECT kind FROM codespaceProviderMutation WHERE resourceId=? AND generation=?")
        .get(before.id, removed.generation);
      expect(mutation).toEqual({ kind: "owner-delete" });
    },
  );
  test.each([
    ["stop", "LOCAL_SETUP_INCOMPLETE"],
    ["reconcile", "LOCAL_SETUP_INCOMPLETE"],
    ["stop", "LOCAL_GUEST_SETTLEMENT_UNKNOWN"],
    ["reconcile", "LOCAL_GUEST_SETTLEMENT_UNKNOWN"],
  ] as const)(
    "known guest setup failure survives physical-stop settlement through %s with %s",
    async (mode, failure) => {
      const actual = await fixture();
      const created = await actual.drive(
        actual.services.resource.create("user-a", actual.target, "main"),
      );
      const localId = await actual.localSpaceId(created.resource);
      const space = (await actual.local.records.get(localId))!;
      await actual.local.records.put({
        ...space,
        phase: "failed",
        desiredState: "stopped",
        lastStartedAt: null,
        // RuntimeOwner's interrupted initial-bootstrap stop retains this exact failed/null tuple;
        // local/guard.test.ts proves its native producer, while this fixture exercises public projection.
        failure,
      });
      actual.physical.set(localId, "stopped");
      if (mode === "reconcile") {
        actual.lifecycle.unknown = true;
        expect(
          await actual.drive(actual.services.resource.stopCodespace("user-a", created.resource.id)),
        ).toMatchObject({ state: "stop_pending" });
        actual.lifecycle.unknown = false;
        sqlite
          .prepare("UPDATE codespaceResource SET claimExpiresAt=NULL WHERE id=?")
          .run(created.resource.id);
        expect(await actual.drive(actual.services.resource.reconcileOnce("user-a"))).toBe(true);
      } else {
        await actual.drive(actual.services.resource.stopCodespace("user-a", created.resource.id));
      }
      const stopped = actual.services.resource.getCodespace("user-a", created.resource.id);
      expect(projectCodespaceSummary(stopped)).toMatchObject({
        state: "stopped",
        lifecycle_error: "CODESPACE_LOCAL_SETUP_INCOMPLETE",
      });
      expect(stopped.observedState).toBe("stopped");
      await actual.drive(actual.services.resource.refreshProviderState("user-a"));
      expect(
        projectCodespaceSummary(actual.services.resource.getCodespace("user-a", stopped.id)),
      ).toMatchObject({ state: "stopped", lifecycle_error: "CODESPACE_LOCAL_SETUP_INCOMPLETE" });
      await expect(
        actual.services.resource.ensureRunning("user-a", stopped.id),
      ).rejects.toMatchObject({ code: "CODESPACE_LOCAL_SETUP_INCOMPLETE" });
      expect(actual.physical.get(localId)).toBe("stopped");
      expect(actual.removal.completed).toBe(0);
    },
  );

  test("initialized guest uncertainty remains a runtime cause and physical uncertainty never certifies shutdown", async () => {
    const actual = await fixture();
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    const localId = await actual.localSpaceId(created.resource);
    const space = (await actual.local.records.get(localId))!;
    expect(space.lastStartedAt).toBeGreaterThan(0);
    await actual.local.records.put({
      ...space,
      phase: "failed",
      desiredState: "stopped",
      failure: "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
    });
    actual.physical.set(localId, "stopped");
    actual.unknownSpaces.add(localId);
    expect(await actual.drive(actual.services.resource.refreshProviderState("user-a"))).toEqual({
      stale: true,
    });
    expect(actual.services.resource.getCodespace("user-a", created.resource.id)).toMatchObject({
      observedState: "running",
      observedAt: created.resource.observedAt,
      lastOutcome: "CODESPACE_LOCAL_RUNTIME_ERROR",
    });
    actual.unknownSpaces.delete(localId);
    const observed = await actual.drive(
      actual.services.provider.getExact(localCodespaceCredential("user-a"), created.resource.id),
    );
    expect(observed).toMatchObject({
      state: "shutdown",
      stateError: "CODESPACE_LOCAL_RUNTIME_ERROR",
    });
    await actual.drive(actual.services.resource.stopCodespace("user-a", created.resource.id));
    await actual.drive(actual.services.resource.refreshProviderState("user-a"));
    expect(
      projectCodespaceSummary(actual.services.resource.getCodespace("user-a", created.resource.id)),
    ).toMatchObject({
      state: "stopped",
      lifecycle_error: "CODESPACE_LOCAL_RUNTIME_ERROR",
    });
    await expect(
      actual.services.resource.ensureRunning("user-a", created.resource.id),
    ).rejects.toMatchObject({
      code: "CODESPACE_LOCAL_RUNTIME_ERROR",
    });
    expect(actual.lifecycle.stopEffects).toBe(0);
    expect(actual.guestActions).toEqual([]);
    expect(actual.physical.get(localId)).toBe("stopped");
  });

  test("a failed bootstrap after early scoped observation remains deletable through the resource service", async () => {
    const actual = await fixture();
    let entered!: () => void, release!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const failPreparation = new Promise<void>((resolve) => {
      release = resolve;
    });
    actual.faults.beforeCreateReady = async () => {
      entered();
      await failPreparation;
      const space = (await actual.local.records.list())[0];
      await actual.local.records.put({
        ...space,
        generation: space.generation + 1,
        phase: "failed",
        desiredState: "stopped",
        failure: "LOCAL_SETUP_INCOMPLETE",
        lastStartedAt: null,
      });
      actual.physical.set(space.id, "stopped");
      throw new LocalRefusal("LOCAL_SETUP_INCOMPLETE", "Controlled failed guest preparation.");
    };
    const driven = actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
      true,
    );
    try {
      await preparing;
      const submitted = actual.services.resource.listResources("user-a")[0];
      const localId = await actual.localSpaceId(submitted);
      expect(
        await actual.services.provider.getExact(localCodespaceCredential("user-a"), submitted.id),
      ).toMatchObject({ state: "starting" });
      const bindingKey = (await actual.state.keys("relay-space-"))[0];
      expect(await actual.state.read(bindingKey, (value) => value)).toMatchObject({
        localSpaceId: localId,
        localGeneration: 1,
        serverGeneration: 2,
      });
      release();
      const failed = await driven;
      expect(await actual.local.records.get(localId)).toMatchObject({
        generation: 2,
        phase: "failed",
        desiredState: "stopped",
        lastStartedAt: null,
        failure: "LOCAL_SETUP_INCOMPLETE",
      });
      await expect(
        actual.relay.gitAuthority(localId, 2, actual.local.policy.repositories[0].id),
      ).rejects.toMatchObject({ code: "LOCAL_CREATE_UNKNOWN" });
      const removed = await actual.drive(
        actual.services.resource.deleteCodespace(
          "user-a",
          failed.resource.id,
          failed.resource.generation,
        ),
      );
      expect(removed).toMatchObject({ state: "deleted", observedState: "absent" });
      expect(actual.removal.completed).toBe(1);
      expect(actual.physical.size).toBe(0);
    } finally {
      release();
      await driven;
      await actual.relay.drain();
    }
  });

  test.each(["stopped", "usable"] as const)(
    "legacy %s metadata without a completed preparation timestamp cannot certify guest readiness",
    async (phase) => {
      const actual = await fixture();
      const created = await actual.drive(
        actual.services.resource.create("user-a", actual.target, "main"),
      );
      const localId = await actual.localSpaceId(created.resource);
      const space = (await actual.local.records.get(localId))!;
      await actual.local.records.put({ ...space, phase, lastStartedAt: null, failure: null });
      if (phase === "stopped") actual.physical.set(localId, "stopped");
      const projected = await actual.drive(
        actual.services.provider.getExact(localCodespaceCredential("user-a"), created.resource.id),
      );
      expect(projected).toMatchObject({
        state: phase === "stopped" ? "shutdown" : "failed",
        stateError: "CODESPACE_LOCAL_SETUP_INCOMPLETE",
      });
      await expect(
        actual.drive(
          actual.services.provider.probeConnector(
            localCodespaceCredential("user-a"),
            created.resource.id,
          ),
        ),
      ).rejects.toMatchObject({ code: "CODESPACE_LOCAL_SETUP_INCOMPLETE" });
      await actual.drive(actual.services.resource.refreshProviderState("user-a"));
      expect(
        projectCodespaceSummary(
          actual.services.resource.getCodespace("user-a", created.resource.id),
        ),
      ).toMatchObject({ lifecycle_error: "CODESPACE_LOCAL_SETUP_INCOMPLETE" });
      await expect(
        actual.services.resource.ensureRunning("user-a", created.resource.id),
      ).rejects.toMatchObject({ code: "CODESPACE_LOCAL_SETUP_INCOMPLETE" });
      await actual.local.records.put({
        ...space,
        phase,
        lastStartedAt: null,
        failure: "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
      });
      actual.unknownSpaces.add(localId);
      expect(
        await actual.drive(
          actual.services.provider.getExact(
            localCodespaceCredential("user-a"),
            created.resource.id,
          ),
        ),
      ).toMatchObject({ state: "unknown", stateError: "CODESPACE_LOCAL_RUNTIME_ERROR" });
      expect(await actual.local.records.list()).toHaveLength(1);
      expect(actual.physical.size).toBe(1);
    },
  );

  test("confirmed incomplete guest preparation projects an actionable bounded setup diagnostic", async () => {
    const actual = await fixture();
    actual.faults.createRefusal = "LOCAL_SETUP_INCOMPLETE";
    const incomplete = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    expect(projectCodespaceSummary(incomplete.resource)).toMatchObject({
      lifecycle_error: "CODESPACE_LOCAL_SETUP_INCOMPLETE",
    });
    const guidance = localCodespaceFailureGuidance("CODESPACE_LOCAL_SETUP_INCOMPLETE")!;
    expect(guidance).toEqual({
      status: 409,
      message:
        "Guest preparation did not complete. Delete this codespace and confirm its removal before creating a replacement; restarting does not complete initial setup.",
    });
    expect(guidance.message).not.toMatch(
      /outcome is not confirmed|wrong.*(?:ref|repository)|Controlled pre-native/,
    );
    await expect(
      actual.services.resource.ensureRunning("user-a", incomplete.resource.id),
    ).rejects.toMatchObject({ code: "CODESPACE_LOCAL_SETUP_INCOMPLETE" });
    expect(await actual.local.records.list()).toHaveLength(0);
    actual.faults.createRefusal = null;
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    const localId = await actual.localSpaceId(created.resource);
    const space = (await actual.local.records.get(localId))!;
    await actual.local.records.put({
      ...space,
      phase: "failed",
      desiredState: "stopped",
      failure: "LOCAL_SETUP_INCOMPLETE",
    });
    actual.physical.set(localId, "stopped");
    expect(
      await actual.drive(
        actual.services.provider.getExact(localCodespaceCredential("user-a"), created.resource.id),
      ),
    ).toMatchObject({ state: "shutdown", stateError: "CODESPACE_LOCAL_SETUP_INCOMPLETE" });
    await expect(
      actual.drive(
        actual.services.provider.probeConnector(
          localCodespaceCredential("user-a"),
          created.resource.id,
        ),
      ),
    ).rejects.toMatchObject({ code: "CODESPACE_LOCAL_SETUP_INCOMPLETE" });
  });

  test("a physically running creating VM keeps bootstrap authority until its guest becomes usable", async () => {
    const actual = await fixture();
    let entered!: () => void, release!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const allowReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    actual.faults.beforeCreateReady = async () => {
      entered();
      await allowReady;
    };
    const driven = actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
      true,
    );
    try {
      await preparing;
      const pending = actual.services.resource.listResources("user-a")[0];
      const localId = await actual.localSpaceId(pending);
      expect(actual.physical.get(localId)).toBe("running");
      expect(await actual.local.records.get(localId)).toMatchObject({
        phase: "creating",
        generation: 1,
      });
      sqlite
        .prepare("UPDATE codespaceResource SET claimExpiresAt=? WHERE id=?")
        .run(actual.clock.now - 1, pending.id);
      // The original background driver services both callers; a second long poll would wait empty.
      expect(await actual.services.resource.reconcileOnce("user-a")).toBe(true);
      expect(actual.services.resource.getCodespace("user-a", pending.id)).toMatchObject({
        state: "create_submitted",
        generation: 2,
        lastOutcome: "provisioning",
      });
      expect(
        await actual.services.provider.getExact(localCodespaceCredential("user-a"), pending.id),
      ).toMatchObject({ state: "starting" });
      await expect(
        actual.services.provider.probeConnector(localCodespaceCredential("user-a"), pending.id),
      ).rejects.toMatchObject({ code: "CODESPACE_NOT_RUNNING" });
      const authority = await actual.relay.gitAuthority(
        localId,
        1,
        actual.local.policy.repositories[0].id,
      );
      expect(authority).toMatchObject({ resourceId: pending.id, resourceGeneration: 2 });
      const row = sqlite
        .prepare(
          "SELECT requestId FROM codespaceLocalRelay WHERE resourceId=? AND status='claimed'",
        )
        .get(pending.id) as { requestId: string };
      const auth = actual.services.devices.getRequest("user-a", row.requestId)!;
      expect(
        actual.services.devices.authorizeGitHubOperation(
          auth,
          pending.id,
          authority.resourceGeneration,
          "fetch",
        ),
      ).toMatchObject({ id: actual.local.policy.repositories[0].id });
      release();
      const returned = await driven;
      expect(returned.resource.id).toBe(pending.id);
      // The expired original claim cannot adopt; fresh reconciliation owns that transition.
      sqlite.prepare("UPDATE codespaceResource SET claimExpiresAt=NULL WHERE id=?").run(pending.id);
      expect(await actual.drive(actual.services.resource.reconcileOnce("user-a"))).toBe(true);
      expect(actual.services.resource.getCodespace("user-a", pending.id)).toMatchObject({
        id: pending.id,
        state: "usable",
        generation: 3,
      });
      expect(await actual.local.records.list()).toHaveLength(1);
      expect(actual.physical.size).toBe(1);
      expect(await actual.local.records.get(localId)).toMatchObject({
        phase: "usable",
        generation: 1,
      });
    } finally {
      release();
      await driven;
      await actual.relay.drain();
    }
  });

  test("an identical terminal ACK after its delivery deadline is read-only and still requires current owner authority", async () => {
    const actual = await fixture();
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    const row = sqlite
      .prepare(
        "SELECT * FROM codespaceLocalRelay WHERE resourceId=? AND status='completed' ORDER BY createdAt,requestId LIMIT 1",
      )
      .get(created.resource.id) as {
      requestId: string;
      claimId: string;
      digest: string;
      outputReference: string;
      deadlineAt: number;
      status: "completed";
    };
    const auth = actual.services.devices.getRequest("user-a", row.requestId)!;
    const ack: LocalRelayAcknowledgement = {
      requestId: row.requestId,
      claimId: row.claimId,
      digest: row.digest,
      status: row.status,
      outcomeReference: JSON.parse(row.outputReference),
    };
    actual.clock.now = row.deadlineAt + 1;
    const before = sqlite
      .prepare("SELECT * FROM codespaceLocalRelay WHERE requestId=?")
      .get(row.requestId);
    expect(actual.services.devices.acknowledge(auth, ack)).toMatchObject({ status: "completed" });
    expect(actual.services.devices.renewClaim(auth, row.requestId, row.claimId)).toMatchObject({
      requestId: row.requestId,
      deadlineAt: row.deadlineAt,
    });
    expect(
      sqlite.prepare("SELECT * FROM codespaceLocalRelay WHERE requestId=?").get(row.requestId),
    ).toEqual(before);
    expect(actual.services.resource.getCodespace("user-a", created.resource.id)).toEqual(
      created.resource,
    );
    expect(() =>
      actual.services.devices.acknowledge(auth, { ...ack, digest: "0".repeat(64) }),
    ).toThrow(expect.objectContaining({ code: "LOCAL_CONFLICT" }));
    sqlite
      .prepare(
        "DELETE FROM codespaceConnectionRepository WHERE connectionId=? AND externalRepositoryId=?",
      )
      .run(created.resource.connectionId, actual.target);
    expect(() => actual.services.devices.acknowledge(auth, ack)).toThrow(
      expect.objectContaining({ code: "LOCAL_UNAUTHORIZED" }),
    );
    expect(() => actual.services.devices.renewClaim(auth, row.requestId, row.claimId)).toThrow(
      expect.objectContaining({ code: "LOCAL_UNAUTHORIZED" }),
    );
    await actual.relay.confirmed();
    expect(actual.services.devices.acknowledge(auth, ack)).toMatchObject({ status: "completed" });
    const device = actual.services.devices.listOwned("user-a").devices[0];
    actual.services.devices.revokeOwned("user-a", device.deviceId, device.deviceGeneration);
    expect(() => actual.services.devices.acknowledge(auth, ack)).toThrow(
      expect.objectContaining({ code: "LOCAL_UNAUTHORIZED" }),
    );
  });

  test("renewal after ACK commit with its HTTP response held returns the same terminal claim without extension", async () => {
    const actual = await fixture();
    let entered!: () => void, release!: () => void;
    const committed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const allowResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldRequest: string | null = null;
    actual.faults.afterAck = async (requestId) => {
      if (heldRequest !== null) return;
      heldRequest = requestId;
      entered();
      await allowResponse;
    };
    const driven = actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
      true,
    );
    try {
      await committed;
      const row = sqlite
        .prepare("SELECT * FROM codespaceLocalRelay WHERE requestId=?")
        .get(heldRequest) as {
        requestId: string;
        claimId: string;
        claimExpiresAt: number;
        deadlineAt: number;
        status: string;
      };
      expect(row.status).toBe("completed");
      const auth = actual.services.devices.getRequest("user-a", row.requestId)!;
      expect(actual.services.devices.renewClaim(auth, row.requestId, row.claimId)).toMatchObject({
        claimId: row.claimId,
        claimExpiresAt: row.claimExpiresAt,
        deadlineAt: row.deadlineAt,
      });
      expect(
        sqlite.prepare("SELECT * FROM codespaceLocalRelay WHERE requestId=?").get(row.requestId),
      ).toEqual(row);
      expect(() => actual.services.devices.renewClaim(auth, row.requestId, randomUUID())).toThrow(
        expect.objectContaining({ code: "LOCAL_CONFLICT" }),
      );
      expect(() =>
        actual.services.devices.authorizePayload(auth, row.requestId, row.claimId),
      ).toThrow(expect.objectContaining({ code: "LOCAL_EXPIRED" }));
    } finally {
      release();
      await driven;
      await actual.relay.drain();
    }
  });

  test("a late admitted create receipt settles after an independent reconciler adopts the same VM", async () => {
    const actual = await fixture();
    let entered!: () => void, release!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const allowReturn = new Promise<void>((resolve) => {
      release = resolve;
    });
    actual.faults.afterCreateAdmitted = async () => {
      entered();
      await allowReturn;
    };
    const creation = actual.services.resource.create("user-a", actual.target, "main");
    const driven = actual.drive(creation, true);
    try {
      await admitted;
      const pending = actual.services.resource.listResources("user-a")[0];
      expect(pending).toMatchObject({ state: "create_submitted", generation: 2 });
      const accepted = sqlite
        .prepare(
          "SELECT requestId,claimId FROM codespaceLocalRelay WHERE resourceId=? AND status='claimed'",
        )
        .get(pending.id) as { requestId: string; claimId: string };
      expect(actual.services.devices.getResult("user-a", accepted.requestId)).toMatchObject({
        status: "claimed",
        outcomeReference: null,
      });
      // Only the server's creation claim expires. Device delivery/lease clocks stay unchanged.
      sqlite
        .prepare("UPDATE codespaceResource SET claimExpiresAt=? WHERE id=?")
        .run(actual.clock.now - 1, pending.id);
      expect(await actual.services.resource.reconcileOnce("user-a")).toBe(true);
      const reconciled = actual.services.resource.getCodespace("user-a", pending.id);
      expect(reconciled).toMatchObject({ state: "usable", generation: 3 });
      const auth = actual.services.devices.getRequest("user-a", accepted.requestId)!;
      // An old input cannot start more work, while the same live accepted claim can settle.
      expect(() =>
        actual.services.devices.authorizePayload(auth, accepted.requestId, accepted.claimId),
      ).toThrow(expect.objectContaining({ code: "LOCAL_UNAUTHORIZED" }));
      expect(
        actual.services.devices.authorizeResult(auth, accepted.requestId, accepted.claimId),
      ).toMatchObject({ resourceGeneration: 2 });
      sqlite
        .prepare(
          "DELETE FROM codespaceConnectionRepository WHERE connectionId=? AND externalRepositoryId=?",
        )
        .run(pending.connectionId, actual.target);
      expect(() =>
        actual.services.devices.authorizeResult(auth, accepted.requestId, accepted.claimId),
      ).toThrow(expect.objectContaining({ code: "LOCAL_UNAUTHORIZED" }));
      await actual.relay.confirmed();
      release();
      const returned = await driven;
      expect(returned.resource).toMatchObject({ id: pending.id, state: "usable", generation: 3 });
      expect(actual.services.resource.getCodespace("user-a", pending.id)).toEqual(reconciled);
      expect(actual.services.devices.getResult("user-a", accepted.requestId)).toMatchObject({
        status: "completed",
      });
      expect(await actual.local.records.list()).toHaveLength(1);
      expect(actual.physical.size).toBe(1);
    } finally {
      release();
      await driven;
      await actual.relay.drain();
    }
  });

  test.each(["start", "stop", "delete"] as const)(
    "missing repository authority refuses %s before mutation and restored grants keep the same resource usable",
    async (action) => {
      const actual = await fixture();
      const created = await actual.drive(
        actual.services.resource.create("user-a", actual.target, "main"),
      );
      const mutations = sqlite
        .prepare("SELECT COUNT(*) AS count FROM codespaceProviderMutation WHERE resourceId=?")
        .get(created.resource.id);
      sqlite
        .prepare(
          "DELETE FROM codespaceConnectionRepository WHERE connectionId=? AND externalRepositoryId=?",
        )
        .run(created.resource.connectionId, actual.target);
      const request = () =>
        action === "start"
          ? actual.services.resource.startCodespace("user-a", created.resource.id)
          : action === "stop"
            ? actual.services.resource.stopCodespace("user-a", created.resource.id)
            : actual.services.resource.deleteCodespace(
                "user-a",
                created.resource.id,
                created.resource.generation,
              );
      await expect(request()).rejects.toMatchObject({ code: "CODESPACE_AUTHORIZATION_REQUIRED" });
      expect(actual.services.resource.getCodespace("user-a", created.resource.id)).toEqual(
        created.resource,
      );
      expect(
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM codespaceProviderMutation WHERE resourceId=?")
          .get(created.resource.id),
      ).toEqual(mutations);
      expect(actual.lifecycle.stopEffects).toBe(0);
      expect(actual.removal.completed).toBe(0);
      // An ordinary authenticated heartbeat restores the applied repository grant.
      await actual.relay.confirmed();
      const restored = await actual.drive(request());
      expect(restored.state).toBe(
        action === "start" ? "usable" : action === "stop" ? "stopped" : "deleted",
      );
      expect(await actual.local.records.list()).toHaveLength(1);
    },
  );

  test.each(["permission", "native"] as const)(
    "explicit delete retries a confirmed %s refusal after repair without replaying the old receipt",
    async (failure) => {
      const actual = await fixture();
      const created = await actual.drive(
        actual.services.resource.create("user-a", actual.target, "main"),
      );
      if (failure === "permission") {
        actual.local.policy.repositories[0].allowDelete = false;
        await actual.state.write("policy.json", actual.local.policy);
      } else actual.faults.removeRefusal = "LOCAL_GUARD_REFUSED";
      const code =
        failure === "permission"
          ? "CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED"
          : "CODESPACE_LOCAL_RUNTIME_ERROR";
      await expect(
        actual.drive(
          actual.services.resource.deleteCodespace(
            "user-a",
            created.resource.id,
            created.resource.generation,
          ),
        ),
      ).rejects.toMatchObject({ code });
      const refused = actual.services.resource.getCodespace("user-a", created.resource.id);
      expect(refused).toMatchObject({ state: "delete_pending", lastOutcome: `refused:${code}` });
      expect(projectCodespaceSummary(refused).lifecycle_error).toBe(code);
      expect(actual.removal.completed).toBe(0);
      actual.local.policy.repositories[0].allowDelete = true;
      await actual.state.write("policy.json", actual.local.policy);
      await actual.relay.confirmed();
      actual.faults.removeRefusal = null;
      const removed = await actual.drive(
        actual.services.resource.deleteCodespace("user-a", refused.id, refused.generation),
      );
      expect(removed.state).toBe("deleted");
      expect(removed.generation).toBeGreaterThan(refused.generation);
      expect(actual.removal.completed).toBe(1);
      expect(actual.physical.size).toBe(0);
      const repeated = await actual.services.resource.deleteCodespace(
        "user-a",
        removed.id,
        removed.generation,
      );
      expect(repeated.generation).toBe(removed.generation);
      expect(actual.removal.completed).toBe(1);
      await expect(
        actual.services.resource.deleteCodespace("user-a", removed.id, refused.generation),
      ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
    },
  );

  test("a retained provider identity remains addressable without migrating its manifest name", async () => {
    const actual = await fixture();
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    const retainedName = await actual.localSpaceId(created.resource);
    sqlite
      .prepare("UPDATE codespaceResource SET providerResourceName=? WHERE id=?")
      .run(retainedName, created.resource.id);
    const executed = await actual.drive(
      actual.services.operation.execute("user-a", created.resource.id, {
        argv: ["echo", "retained identity"],
        stdin: { kind: "inline", bytes: new Uint8Array() },
      }),
    );
    expect(executed.result?.stdout).toBe("retained identity");
    expect(
      actual.services.resource.getCodespace("user-a", created.resource.id).providerResourceName,
    ).toBe(retainedName);
    expect(await actual.local.records.list()).toHaveLength(1);
  });

  test("an exact owned unknown VM can stop without false completion or disturbing its healthy peer", async () => {
    const actual = await fixture();
    const first = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    const peer = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    const localId = await actual.localSpaceId(first.resource);
    const peerId = await actual.localSpaceId(peer.resource);
    actual.unknownSpaces.add(localId);
    const stopped = await actual.drive(
      actual.services.resource.stopCodespace("user-a", first.resource.id),
    );
    expect(actual.lifecycle.stopEffects).toBe(1);
    expect(actual.physical.get(localId)).toBe("stopped");
    expect(stopped).toMatchObject({
      state: "stop_pending",
      desiredState: "stopped",
      observedAt: first.resource.observedAt,
      observedState: "running",
      lastOutcome: "CODESPACE_LOCAL_CREATION_UNKNOWN",
    });
    expect(actual.physical.get(peerId)).toBe("running");
    const healthy = await actual.drive(
      actual.services.operation.execute("user-a", peer.resource.id, {
        argv: ["echo", "peer survives unknown stop"],
        stdin: { kind: "inline", bytes: new Uint8Array() },
      }),
    );
    expect(healthy.result?.stdout).toBe("peer survives unknown stop");
    actual.unknownSpaces.delete(localId);
    sqlite
      .prepare("UPDATE codespaceResource SET claimExpiresAt=NULL WHERE id=?")
      .run(first.resource.id);
    expect(await actual.drive(actual.services.resource.reconcileOnce("user-a"))).toBe(true);
    expect(actual.services.resource.getCodespace("user-a", first.resource.id)).toMatchObject({
      state: "stopped",
      observedState: "stopped",
    });
    expect(actual.lifecycle.stopEffects).toBe(1);
    expect(actual.physical.get(peerId)).toBe("running");
  });

  test("one unknown VM leaves its confirmed state intact while its healthy peer is freshly observed", async () => {
    const actual = await fixture();
    const first = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    const second = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    expect(second.resource.providerResourceName).not.toBe(first.resource.providerResourceName);
    sqlite
      .prepare("UPDATE codespaceResource SET observedAt=7 WHERE id IN (?,?)")
      .run(first.resource.id, second.resource.id);
    actual.unknownSpaces.add(await actual.localSpaceId(first.resource));
    expect(await actual.drive(actual.services.resource.refreshProviderState("user-a"))).toEqual({
      stale: true,
    });
    expect(actual.services.resource.getCodespace("user-a", first.resource.id)).toMatchObject({
      observedAt: 7,
      observedState: "running",
      lastOutcome: "CODESPACE_LOCAL_CREATION_UNKNOWN",
    });
    expect(actual.services.resource.getCodespace("user-a", second.resource.id)).toMatchObject({
      observedAt: actual.clock.now,
      observedState: "running",
    });
    await expect(
      actual.services.resource.ensureRunning("user-a", first.resource.id),
    ).rejects.toMatchObject({ code: "CODESPACE_LOCAL_CREATION_UNKNOWN" });
    const healthy = await actual.drive(
      actual.services.operation.execute("user-a", second.resource.id, {
        argv: ["echo", "peer remains usable"],
        stdin: { kind: "inline", bytes: new Uint8Array() },
      }),
    );
    expect(healthy.result?.stdout).toBe("peer remains usable");
  });

  test.each([false, true])(
    "a detached long command (background=%s) keeps its full execution budget and is collected without redispatch",
    async (background) => {
      const actual = await fixture();
      actual.policy.maxOperationMs = 15 * 60_000;
      actual.faults.detachExecution = true;
      const created = await actual.drive(
        actual.services.resource.create("user-a", actual.target, "main"),
      );
      const submitted = await actual.drive(
        actual.services.operation.execute("user-a", created.resource.id, {
          argv: ["echo", "long command result"],
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 10 * 60_000,
          background,
        }),
      );
      expect(submitted.operation.deadlineAt - actual.clock.now).toBe(10 * 60_000);
      const completed = background
        ? await actual.drive(actual.services.operation.reconcile("user-a", submitted.operation.id))
        : submitted.result;
      expect(completed).toMatchObject({ state: "succeeded", stdout: "long command result" });
      expect(actual.guestActions.filter((action) => action === "execute")).toHaveLength(1);
      expect(
        await actual.state.read(
          `effect-${submitted.operation.remoteMarker}.json`,
          (value) => value,
        ),
      ).toEqual({ argv: ["echo", "long command result"], stdin: "" });
      const delivery = sqlite
        .prepare(
          "SELECT MAX(deadlineAt-createdAt) AS budget FROM codespaceLocalRelay WHERE resourceId=? AND requestId IN (SELECT requestId FROM codespaceLocalRelay WHERE inputReference IS NOT NULL)",
        )
        .get(created.resource.id) as { budget: number };
      expect(delivery.budget).toBeLessThanOrEqual(150_000);
    },
  );

  test("an unresolved older creation does not block a neighboring codespace and can be deleted without a VM", async () => {
    const actual = await fixture();
    actual.faults.createRefusal = "LOCAL_INTERNAL_ERROR";
    const abandoned = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    expect(abandoned.resource).toMatchObject({
      state: "create_submitted",
      providerResourceName: null,
      lastOutcome: "CODESPACE_LOCAL_RUNTIME_ERROR",
    });
    expect(await actual.local.records.list()).toHaveLength(0);
    actual.faults.createRefusal = null;
    const healthy = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    expect(healthy.resource.state).toBe("usable");
    expect(await actual.local.records.list()).toHaveLength(1);
    const removed = await actual.drive(
      actual.services.resource.deleteCodespace(
        "user-a",
        abandoned.resource.id,
        abandoned.resource.generation,
      ),
    );
    expect(removed).toMatchObject({
      state: "deleted",
      observedState: "absent",
      lastOutcome: "verified_never_created",
    });
    const repeat = await actual.services.resource.deleteCodespace(
      "user-a",
      removed.id,
      removed.generation,
    );
    expect(repeat.generation).toBe(removed.generation);
    expect(actual.services.resource.getCodespace("user-a", healthy.resource.id).state).toBe(
      "usable",
    );
    expect((await actual.local.records.list())[0].id).toBe(
      await actual.localSpaceId(healthy.resource),
    );
  });

  test("creation identity is restored from the scoped manifest after its short-lived reply is gone", async () => {
    const actual = await fixture();
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    sqlite
      .prepare(
        "UPDATE codespaceResource SET state='create_submitted',providerResourceName=NULL,externalOwnerId=NULL,billableOwnerId=NULL,generation=2,claimId=NULL,claimExpiresAt=NULL WHERE id=?",
      )
      .run(created.resource.id);
    sqlite
      .prepare("UPDATE codespaceLocalRelay SET outputReference=NULL WHERE resourceId=?")
      .run(created.resource.id);
    await actual.drive(actual.services.resource.reconcileOnce("user-a"));
    expect(actual.services.resource.getCodespace("user-a", created.resource.id)).toMatchObject({
      state: "usable",
      providerResourceName: created.resource.providerResourceName,
    });
    expect(await actual.local.records.list()).toHaveLength(1);
  });

  test("a rejected never-created intent can be removed without contacting the companion", async () => {
    const actual = await fixture();
    actual.faults.createRefusal = "LOCAL_INTERNAL_ERROR";
    const pending = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    await actual.drive(actual.services.resource.reconcileOnce("user-a"));
    const rejected = actual.services.resource.getCodespace("user-a", pending.resource.id);
    expect(rejected.state).toBe("rejected");
    const removed = await actual.services.resource.deleteCodespace(
      "user-a",
      rejected.id,
      rejected.generation,
    );
    expect(removed).toMatchObject({
      state: "deleted",
      providerResourceName: null,
      observedState: "absent",
    });
    expect(await actual.local.records.list()).toHaveLength(0);
    await expect(
      actual.services.resource.deleteCodespace("user-a", removed.id, rejected.generation),
    ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
  });

  test("an exact owned unknown runtime stays stale but remains deletable", async () => {
    const actual = await fixture();
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    actual.lifecycle.unknown = true;
    const refresh = await actual.drive(actual.services.resource.refreshProviderState("user-a"));
    expect(refresh.stale).toBe(true);
    expect(actual.services.resource.getCodespace("user-a", created.resource.id)).toMatchObject({
      observedAt: created.resource.observedAt,
      observedState: "running",
      lastOutcome: "CODESPACE_LOCAL_CREATION_UNKNOWN",
    });
    const removed = await actual.drive(
      actual.services.resource.deleteCodespace(
        "user-a",
        created.resource.id,
        created.resource.generation,
      ),
    );
    expect(removed).toMatchObject({ state: "deleted", observedState: "absent" });
    expect(actual.physical.size).toBe(0);
  });

  test("created is actionable but not a stop certificate, and a pending stop reuses its durable receipt", async () => {
    const actual = await fixture();
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    const spaceId = await actual.localSpaceId(created.resource);
    actual.physical.set(spaceId, "created");
    actual.lifecycle.stopSettles = false;
    const pending = await actual.drive(
      actual.services.resource.stopCodespace("user-a", created.resource.id),
    );
    expect(pending).toMatchObject({
      state: "stop_pending",
      observedState: "created",
      desiredState: "stopped",
    });
    expect(actual.lifecycle.stopEffects).toBe(1);
    actual.clock.now += 6 * 60_000;
    const replay = await actual.drive(
      actual.services.resource.stopCodespace("user-a", created.resource.id),
    );
    expect(replay.state).toBe("stop_pending");
    expect(replay.generation).toBe(pending.generation);
    expect(actual.lifecycle.stopEffects).toBe(1);
    const saved = sqlite
      .prepare(
        "SELECT outputReference FROM codespaceLocalRelay WHERE resourceId=? AND status='completed' AND outputReference IS NOT NULL",
      )
      .all(created.resource.id) as { outputReference: string }[];
    expect(
      saved.some((row) =>
        sqlite
          .prepare("SELECT 1 FROM codespaceTransfer WHERE id=?")
          .get(JSON.parse(row.outputReference).parts[0].transferId),
      ),
    ).toBe(true);
    actual.physical.set(spaceId, "stopped");
    const stopped = await actual.drive(
      actual.services.resource.stopCodespace("user-a", created.resource.id),
    );
    expect(stopped).toMatchObject({
      state: "stopped",
      observedState: "stopped",
      desiredState: "stopped",
    });
    expect(actual.lifecycle.stopEffects).toBe(1);
  });

  test("unknown observation persists a safe refusal without changing verified freshness and recovers on retry", async () => {
    const actual = await fixture();
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    expect(created.resource.observedAt).not.toBeNull();
    actual.lifecycle.unknown = true;
    const pending = await actual.drive(
      actual.services.resource.stopCodespace("user-a", created.resource.id),
    );
    expect(pending).toMatchObject({
      state: "stop_pending",
      desiredState: "stopped",
      generation: created.resource.generation + 1,
      lastOutcome: "CODESPACE_LOCAL_CREATION_UNKNOWN",
    });
    const unavailable = actual.services.resource.getCodespace("user-a", created.resource.id);
    expect(unavailable).toMatchObject({
      state: "stop_pending",
      observedState: "running",
      observedAt: created.resource.observedAt,
    });
    expect(projectCodespaceSummary(unavailable)).toMatchObject({
      observed_at: created.resource.observedAt,
      lifecycle_error: "CODESPACE_LOCAL_CREATION_UNKNOWN",
    });
    expect(actual.lifecycle.stopEffects).toBe(1);
    expect(actual.physical.get(await actual.localSpaceId(created.resource))).toBe("stopped");
    await expect(
      actual.services.resource.ensureRunning("user-a", created.resource.id),
    ).rejects.toMatchObject({ code: "CODESPACE_LOCAL_CREATION_UNKNOWN" });
    sqlite.prepare("UPDATE codespaceResource SET observedAt=7 WHERE id=?").run(created.resource.id);
    await actual.drive(actual.services.resource.reconcileOnce("user-a"));
    expect(actual.services.resource.getCodespace("user-a", created.resource.id)).toMatchObject({
      observedAt: 7,
      lastOutcome: "CODESPACE_LOCAL_CREATION_UNKNOWN",
    });
    await expect(
      actual.drive(actual.services.resource.startCodespace("user-a", created.resource.id)),
    ).rejects.toMatchObject({ code: "CODESPACE_LOCAL_CREATION_UNKNOWN" });
    expect(actual.physical.get(await actual.localSpaceId(created.resource))).toBe("stopped");
    actual.lifecycle.unknown = false;
    const stopped = await actual.drive(
      actual.services.resource.stopCodespace("user-a", created.resource.id),
    );
    expect(projectCodespaceSummary(stopped)).toMatchObject({
      state: "stopped",
      lifecycle_error: null,
    });
    expect(stopped.observedAt).toBeGreaterThan(7);
    expect(actual.lifecycle.stopEffects).toBe(1);
    // A restart prepares the guest through the ordinary locally owned broker lifecycle.
    actual.manager.dependencies.brokerPorts = { http: 0, tunnel: 0 };
    await actual.manager.open();
    const observationTime = actual.clock.now;
    const probe = actual.services.provider.probeConnector.bind(actual.services.provider);
    actual.services.provider.probeConnector = async (credential, name) => {
      actual.clock.now += 100;
      await probe(credential, name);
    };
    const restarted = await actual.drive(
      actual.services.resource.startCodespace("user-a", created.resource.id),
    );
    expect(restarted).toMatchObject({
      state: "usable",
      observedAt: observationTime,
      updatedAt: observationTime + 100,
    });
  });

  test("an explicit local runtime error cannot certify stopped", async () => {
    const actual = await fixture();
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    actual.physical.set(await actual.localSpaceId(created.resource), "error");
    actual.lifecycle.stopSettles = false;
    await expect(
      actual.drive(actual.services.resource.stopCodespace("user-a", created.resource.id)),
    ).rejects.toMatchObject({ code: "CODESPACE_LOCAL_RUNTIME_ERROR" });
    expect(actual.services.resource.getCodespace("user-a", created.resource.id)).toMatchObject({
      state: "stop_pending",
      observedState: "failed",
    });
    expect(actual.lifecycle.stopEffects).toBe(1);
  });

  test("a full native file quota leaves authenticated local lifecycle and commands operational", async () => {
    const actual = await fixture(4 * 1024 * 1024, 1);
    const fullBytes = 4 * 1024 * 1024;
    actual.policy.maxTransferBytesPerUser = fullBytes;
    actual.policy.maxTransferBytesGlobal = fullBytes;
    actual.policy.maxTransferInflightBytesPerUser = fullBytes;
    actual.policy.maxTransferInflightBytesGlobal = fullBytes;
    const native = await actual.services.transfer.createDownload("user-a", {
      fileName: "held.bin",
      mimeType: "application/octet-stream",
      bytes: Buffer.alloc(fullBytes),
    });
    await expect(
      actual.services.transfer.createDownload("user-a", {
        fileName: "excess.bin",
        mimeType: "application/octet-stream",
        bytes: Buffer.from("x"),
      }),
    ).rejects.toMatchObject({ code: "CODESPACE_POLICY_LIMIT" });
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    expect(created.resource.state).toBe("usable");
    const executed = await actual.drive(
      actual.services.operation.execute("user-a", created.resource.id, {
        argv: ["echo", "control remains usable"],
        stdin: { kind: "inline", bytes: new Uint8Array() },
      }),
    );
    expect(executed.operation.state).toBe("succeeded");
    expect(executed.result?.stdout).toBe("control remains usable");
    expect(new CodespaceTransferRepository(sqlite).usageForUser("user-a")).toEqual({
      objects: 1,
      bytes: fullBytes,
      inflightBytes: 0,
    });
    const claimed = await actual.services.transfer.claimDownload(native.referenceId);
    expect(claimed.record.observedSize).toBe(fullBytes);
    await actual.services.transfer.consume(claimed.record);
    expect(new CodespaceTransferRepository(sqlite).usageForUser("user-a")).toEqual({
      objects: 0,
      bytes: 0,
      inflightBytes: 0,
    });
  });

  test.each(["exec", "read"] as const)(
    "settles an old %s marker after the server generation advances without redispatch",
    async (kind) => {
      const actual = await fixture();
      const created = await actual.drive(
        actual.services.resource.create("user-a", actual.target, "main"),
      );
      actual.faults.holdOperations = true;
      await writeFile(join(actual.guestRoot, "payload.bin"), Buffer.from("retained file"));
      const pending =
        kind === "exec"
          ? await actual.drive(
              actual.services.operation.execute("user-a", created.resource.id, {
                argv: ["echo", "old command"],
                stdin: { kind: "inline", bytes: new Uint8Array() },
                background: true,
                timeoutMs: 5000,
              }),
            )
          : await actual.drive(
              actual.services.file.execute("user-a", created.resource.id, {
                action: "read",
                path: "payload.bin",
                offset: 0,
                length: 13,
              }),
            );
      expect(pending.operation.state).toBe("running");
      const originalGeneration = pending.operation.resourceGeneration;
      sqlite
        .prepare("UPDATE codespaceResource SET generation=generation+2 WHERE id=?")
        .run(created.resource.id);
      sqlite
        .prepare(
          "UPDATE codespaceOperation SET state='cancel_pending',claimId=NULL,claimExpiresAt=NULL WHERE id=?",
        )
        .run(pending.operation.id);
      actual.faults.holdOperations = false;
      expect(await actual.drive(actual.services.operation.reconcileOnce("user-a"))).toBe(true);
      const settled = actual.services.operation.get("user-a", pending.operation.id)!;
      expect(settled.state).toBe(kind === "exec" ? "cancelled" : "succeeded");
      expect(settled.resourceGeneration).toBe(originalGeneration);
      expect(
        actual.guestActions.filter(
          (action) => action === (kind === "exec" ? "execute" : "file-execute"),
        ),
      ).toHaveLength(1);
      const fresh = await actual.drive(
        actual.services.operation.execute("user-a", created.resource.id, {
          argv: ["echo", "fresh"],
          stdin: { kind: "inline", bytes: new Uint8Array() },
        }),
      );
      expect(fresh.operation.state).toBe("succeeded");
      expect(fresh.result?.stdout).toBe("fresh");
    },
  );

  test.each(["generation", "future", "name", "provider", "owner", "authorization"])(
    "old operation recovery refuses changed %s before contacting relay",
    async (change) => {
      const actual = await fixture();
      const created = await actual.drive(
        actual.services.resource.create("user-a", actual.target, "main"),
      );
      const executed = await actual.drive(
        actual.services.operation.execute("user-a", created.resource.id, {
          argv: ["true"],
          stdin: { kind: "inline", bytes: new Uint8Array() },
        }),
      );
      const resource = { ...created.resource, generation: created.resource.generation + 1 };
      const operation = { ...executed.operation };
      let sends = 0;
      class NoGuestRelay extends LocalCodespaceRelay {
        override async send() {
          sends++;
          return { state: "absent" };
        }
      }
      const transport = new LocalCodespaceJobTransport(
        new NoGuestRelay(actual.services.devices, actual.services.transfer),
      );
      if (change === "future") operation.resourceGeneration = resource.generation + 1;
      if (change === "name") operation.providerResourceName = "another-owned-space";
      if (change === "provider") operation.provider = "github-codespaces";
      if (change === "owner") operation.userId = "user-b";
      if (change === "authorization") operation.authorizationGeneration++;
      if (change === "generation")
        await expect(
          transport.execute(localCodespaceCredential("user-a"), resource, operation, {
            argv: ["true"],
            stdin: { kind: "inline", bytes: new Uint8Array() },
          }),
        ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
      else
        await expect(
          transport.cancel(localCodespaceCredential("user-a"), resource, operation),
        ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
      expect(sends).toBe(0);
    },
  );
  test("creates and adopts a local resource through owned SQL, private blobs, HTTP and actual RPC without GitHub OAuth", async () => {
    const actual = await fixture();
    expect(actual.services.connection.getStatus("user-a").state).toBe("connected");
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) count FROM codespaceConnection WHERE provider='github-codespaces'",
        )
        .get(),
    ).toEqual({ count: 0 });
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    expect(created.resource.state).toBe("usable");
    expect(created.resource.provider).toBe("local-sandboxes");
    expect(created.resource.repositoryId).toBe(actual.target);
    const spaces = await actual.local.records.list();
    expect(spaces).toHaveLength(1);
    expect(created.resource.providerResourceName).toBe(created.resource.id);
    expect(spaces[0].operationMarker).toBe(created.resource.operationMarker);
  });
  test("uses the adopted generation for native stdin and native binary upload/read through the actual relay", async () => {
    const actual = await fixture(1024 * 1024, 10, 1024 * 1024);
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    const reference = {
      fileId: "file_localNative",
      downloadUrl: "https://native.example.test/object",
      mimeType: "application/octet-stream",
      declaredSize: actual.nativeBytes.length,
    };
    const executed = await actual.drive(
      actual.services.operation.executeNativeReference(
        "user-a",
        created.resource.id,
        { argv: ["cat", "private-argv-canary"] },
        reference,
      ),
    );
    if (executed.operation.state !== "succeeded") {
      const rows = sqlite
        .prepare("SELECT requestId FROM codespaceLocalRelay WHERE status='refused'")
        .all() as { requestId: string }[];
      const errors = [];
      for (const row of rows) {
        const result = actual.services.devices.getResult("user-a", row.requestId)!;
        if (result.outcomeReference) {
          const bytes = await actual.services.transfer.readRelayPayload(
            "user-a",
            "local_relay_output",
            result.outcomeReference,
          );
          errors.push(JSON.parse(bytes.toString()).error);
        }
      }
      throw new Error(`Native execution ${executed.operation.state}: ${JSON.stringify(errors)}`);
    }
    expect(executed.operation.state).toBe("succeeded");
    expect(executed.result?.stdout).toBe("controlled guest result");
    const effect = await actual.state.read(
      `effect-${executed.operation.remoteMarker}.json`,
      (value) => value,
    );
    expect(effect).toEqual({
      argv: ["cat", "private-argv-canary"],
      stdin: actual.nativeBytes.toString("base64"),
    });
    const uploaded = await actual.drive(
      actual.services.file.uploadReference("user-a", created.resource.id, {
        path: "payload.bin",
        reference,
        expected: { exists: false },
      }),
    );
    expect(uploaded.operation.state).toBe("succeeded");
    expect(await readFile(join(actual.guestRoot, "payload.bin"))).toEqual(actual.nativeBytes);
    const read = await actual.drive(
      actual.services.file.execute("user-a", created.resource.id, {
        action: "read",
        path: "payload.bin",
        offset: 0,
        length: actual.nativeBytes.length,
      }),
    );
    expect(read.operation.state).toBe("succeeded");
    expect(read.result).toMatchObject({
      action: "read",
      path: "payload.bin",
      sha256: hash(actual.nativeBytes),
    });
    expect(read.result && "bytes" in read.result ? Buffer.from(read.result.bytes) : null).toEqual(
      actual.nativeBytes,
    );
    expect(sqlite.serialize().includes(Buffer.from("private-argv-canary"))).toBe(false);
    const readRows = sqlite
      .prepare(
        "SELECT requestId FROM codespaceLocalRelay WHERE status='completed' AND json_array_length(outputReference,'$.parts')>1",
      )
      .all() as { requestId: string }[];
    expect(readRows.length).toBeGreaterThanOrEqual(1);
    for (const row of readRows) {
      const reference = actual.services.devices.getResult(
        "user-a",
        row.requestId,
      )!.outcomeReference!;
      expect(reference.parts.length).toBeGreaterThan(1);
      expect(reference.parts.every((part) => part.size <= 1024 * 1024)).toBe(true);
    }
    expect(
      sqlite
        .prepare("SELECT COUNT(*) count FROM codespaceLocalRelay WHERE status='completed'")
        .get(),
    ).toMatchObject({ count: expect.any(Number) });
  });
  test("recovers a lost acknowledged create response without creating a second local sandbox", async () => {
    const actual = await fixture();
    actual.faults.dropNextAck = true;
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    expect(actual.faults.lostAcknowledgements).toBe(1);
    expect(created.resource.state).toBe("usable");
    expect(await actual.local.records.list()).toHaveLength(1);
    const requests = sqlite
      .prepare(
        `SELECT requestId FROM codespaceLocalRelay r WHERE status='completed'
      AND EXISTS(SELECT 1 FROM codespaceTransfer t WHERE t.id=json_extract(r.inputReference,'$.parts[0].transferId'))`,
      )
      .all() as { requestId: string }[];
    const creates = [];
    for (const row of requests) {
      const entry = actual.services.devices.getRequest("user-a", row.requestId)!;
      const bytes = await actual.services.transfer.readRelayPayload(
        "user-a",
        "local_relay_input",
        entry.payloadReference,
      );
      if (JSON.parse(bytes.toString()).request.action === "create") creates.push(entry);
    }
    expect(creates).toHaveLength(1);
  });
  test("revocation fences a queued create before it reaches companion or runtime", async () => {
    const actual = await fixture();
    const outcome = actual.services.resource.create("user-a", actual.target, "main").then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    while (
      !(
        sqlite
          .prepare("SELECT COUNT(*) count FROM codespaceLocalRelay WHERE status='queued'")
          .get() as { count: number }
      ).count
    )
      await delay(5);
    const device = actual.services.devices.listOwned("user-a").devices[0];
    actual.services.devices.revokeOwned("user-a", device.deviceId, device.deviceGeneration);
    const result = await outcome;
    if (!("value" in result)) throw result.error;
    expect(result.value.resource.state).toBe("create_submitted");
    expect(result.value.resource.lastOutcome).toBe("CODESPACE_AUTHORIZATION_REQUIRED");
    expect(await actual.local.records.list()).toHaveLength(0);
    expect(
      sqlite.prepare("SELECT COUNT(*) count FROM codespaceLocalRelay WHERE status='revoked'").get(),
    ).toEqual({ count: 1 });
    await expect(actual.relay.poll(actual.rpc)).rejects.toMatchObject({
      code: "LOCAL_UNAUTHORIZED",
    });
  });
  test("collects completed private payloads so sequential commands fit the default ten-object quota", async () => {
    const actual = await fixture(4 * 1024 * 1024, 10);
    const created = await actual.drive(
      actual.services.resource.create("user-a", actual.target, "main"),
    );
    for (let index = 0; index < 12; index++) {
      const text = `guest-output-${index}`;
      const executed = await actual.drive(
        actual.services.operation.execute("user-a", created.resource.id, {
          argv: ["echo", text],
          stdin: { kind: "inline", bytes: new Uint8Array() },
        }),
      );
      expect(executed.operation.state).toBe("succeeded");
      expect(executed.result?.stdout).toBe(text);
      const count = sqlite
        .prepare("SELECT COUNT(*) count FROM codespaceTransfer WHERE userId='user-a'")
        .get() as { count: number };
      expect(count.count).toBeLessThanOrEqual(2);
    }
    expect(
      sqlite.prepare("SELECT COUNT(*) count FROM codespaceOperation WHERE state='succeeded'").get(),
    ).toEqual({ count: 12 });
  });
});
