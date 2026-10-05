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
import { setTimeout as delay } from "node:timers/promises";
import {
  CodespaceTransferService,
  CodespaceTransferRepository,
  localRepositoryTargetId,
  type CodespaceResourcePolicy,
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
import {
  SbxRuntime,
  type SandboxIdentity,
  type SandboxObservation,
} from "../../packages/local/src/sbx-runtime.js";
import { requireLocalGrant } from "../../packages/local/src/policy.js";
import { localFixture } from "./local/fixtures.js";

let root: string, sqlite: Database.Database;
beforeEach(async () => {
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
  sqlite.close();
  await rm(root, { recursive: true, force: true });
});
const boundaryBytes = Buffer.from("controlled external-runtime boundary");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture(partLimit = 4 * 1024 * 1024, maxObjects = 512, nativeSize = 5) {
  const state = await PrivateState.open(join(root, "companion"));
  const local = await localFixture(state);
  local.policy.leaseUntil = Date.now() + 3600_000;
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
  });
  const services = createLocalCodespaceServices(transfer, {
    sqlite,
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
  const faults = { dropNextAck: false, lostAcknowledgements: 0 };
  let setupRefusal: { status: number; code: string } | undefined;
  let connecting = true;
  const fetch: typeof globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://moira.example");
    options?.signal?.throwIfAborted();
    let call =
      options?.method === "POST"
        ? request(app).post(url.pathname + url.search)
        : request(app).get(url.pathname + url.search);
    new Headers(options?.headers).forEach((value, key) => {
      call = call.set(key, value);
    });
    if (options?.body !== undefined && options.body !== null) {
      if (typeof options.body === "string") call = call.send(options.body);
      else if (options.body instanceof Uint8Array) call = call.send(Buffer.from(options.body));
      else throw new Error("Unexpected controlled request body");
    }
    const response = await call;
    if (connecting && response.status >= 400) {
      const code: unknown = response.body?.error?.code;
      setupRefusal = {
        status: response.status,
        code: typeof code === "string" && /^[A-Z_]{1,80}$/.test(code) ? code : "NO_SAFE_CODE",
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
    override async verifySettings() {}
    override async verifyBoundary() {}
    override async networkPolicy() {
      return boundaryBytes;
    }
    override async list(): Promise<SandboxObservation[]> {
      return (await local.records.list())
        .filter((space) => space.phase !== "deleted" && space.runtimeId !== null)
        .map((space) => ({
          id: space.runtimeId!,
          name: space.name,
          agent: "shell",
          status: space.desiredState === "running" ? "running" : "stopped",
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
      } else if (job.action === "finalize") result = { state: "absent" };
      else throw new Error("Unexpected controlled operation request");
      return Buffer.from(JSON.stringify({ ok: true, result }));
    }
  }
  const runtime = new ExternalRuntime(local.policy);
  const manager = new LocalManager(local.records, {
    runtime: () => runtime,
    storage: async () => undefined,
    guard: async () => ({
      active: true,
      stop: async () => {},
      observe: () => runtime.list(),
      retire: async () => {},
      remove: async () => {},
      space: async (id) => ({
        active: true,
        prepare: async () => {},
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
          if (space)
            await local.records.put({
              ...space,
              desiredState: "stopped",
              phase: "stopped",
              generation: space.generation + 1,
            });
        },
      }),
    }),
  });
  // Substitute only external startup. SQL/provider/relay/RPC/journals and operation admission remain actual code.
  manager.create = async (repositoryId, ref, operationMarker) => {
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
      lastStartedAt: Date.now(),
      networkPolicy: hash(boundaryBytes),
    };
    await local.records.put(space);
    return space;
  };
  const rpc = new LocalRpc(manager),
    relay = new LocalRelay(local.records, fetch);
  const pairResponse = await request(app).post("/api/integrations/local/pairings").send({});
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
    const confirmed = await request(app)
      .post(`/api/integrations/local/pairings/${pairing.pairingId}/confirm`)
      .send({ expectedRevision: pending.pairing.revision });
    expect(confirmed.status).toBe(200);
    await relay.confirmed();
  } catch (cause) {
    throw new Error(
      `Fixture connection setup refused: HTTP ${setupRefusal?.status ?? "UNKNOWN"}, code ${setupRefusal?.code ?? "UNKNOWN"}`,
      { cause },
    );
  }
  connecting = false;
  const drive = async <T>(work: Promise<T>): Promise<T> => {
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
        try {
          await relay.poll(rpc);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "Controlled lost acknowledgement response"
          )
            throw error;
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
    target: localRepositoryTargetId(local.policy.deviceId, local.policy.repositories[0].id),
  };
}

describe("actual local-only service composition and outbound relay", () => {
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
    expect(created.resource.providerResourceName).toBe(spaces[0].id);
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
    expect(result.value.resource.lastOutcome).toBe("provider_outcome_unknown");
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
