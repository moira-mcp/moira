import { expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { extract } from "tar-stream";
import {
  communicationOwnerReceiptSchema,
  parseCommunicationOwnerReference,
} from "../../../packages/shared/src/communication-owner-protocol.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalDaemon } from "../../../packages/local/src/daemon.js";
import { LocalRelay } from "../../../packages/local/src/relay.js";
import { LocalRefusal } from "../../../packages/local/src/policy.js";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { controllerRequest, startLocalController } from "../../../packages/local/src/controller.js";
import {
  collectServiceMaintenance,
  runLocalService,
  serviceFailure,
  serviceRequest,
} from "../../../packages/local/src/service.js";
import { localFixture } from "./fixtures.js";

const release = "a".repeat(64);
const originalRequestId = () => `ws1-${randomUUID()}`;

function publicationBytes(socketPath: string, token: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { socketPath, method: "GET", path: `/v1/publications/${token}` },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          if (response.statusCode !== 200)
            reject(new Error(`Publication refused: ${response.statusCode}`));
          else resolve(Buffer.concat(chunks));
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function archiveFiles(bytes: Buffer): Promise<{ path: string; content: string }[]> {
  const parser = extract();
  const files: { path: string; content: string }[] = [];
  return new Promise((resolve, reject) => {
    parser.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("error", reject);
      stream.once("end", () => {
        files.push({ path: header.name, content: Buffer.concat(chunks).toString("utf8") });
        next();
      });
      stream.resume();
    });
    parser.once("error", reject);
    parser.once("finish", () => resolve(files));
    parser.end(bytes);
  });
}

test.each([false, true])(
  "controller publishes and collects exact archives while native login is unavailable (retained failure: %s)",
  async (retainedFailure) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "moira-native-failure-")));
    const state = await PrivateState.open(root);
    const f = await localFixture(state);
    Object.assign(f.space, {
      admittedMachine: {
        cpuCores: f.policy.runtime.cpuCores,
        memoryBytes: f.policy.runtime.memoryBytes,
        dockerBytes: f.policy.runtime.dockerBytes,
      },
      admittedRepositoryFullName: f.policy.repositories[0].fullName,
    });
    await f.records.put(f.space);
    const connection = {
      userId: "fixture-owner",
      deviceId: f.policy.deviceId,
      deviceGeneration: 1,
      connectionId: randomUUID(),
      origin: "https://moira.example",
      credential: "a".repeat(43),
      pairingId: randomUUID(),
    };
    await state.write("connection.json", connection);
    const { userId, deviceId, deviceGeneration, connectionId } = connection;
    const identity = { userId, deviceId, deviceGeneration, connectionId };
    const unknownId = originalRequestId();
    const unknownKey = `controller-operation-${unknownId}.json`;
    await state.write(unknownKey, {
      requestId: unknownId,
      digest: "c".repeat(64),
      identity,
      state: "accepted",
    });
    const unknownBytes = await readFile(join(root, unknownKey));
    const oldFailure = {
      release: "b".repeat(64),
      code: "LOCAL_DOCKER_LOGIN_REQUIRED",
      at: 1234,
    };
    if (retainedFailure) await state.write("service-failure.json", oldFailure);
    let socketPath = "",
      nativeAttempts = 0,
      controllerOnline!: () => void;
    const controllerReady = new Promise<void>((resolve) => {
      controllerOnline = resolve;
    });
    const manager = new LocalManager(f.records, {
      storage: async () => undefined,
      guard: async () => {
        nativeAttempts++;
        await controllerReady;
        throw new LocalRefusal(
          "LOCAL_DOCKER_LOGIN_REQUIRED",
          "Controlled native prerequisite failure",
        );
      },
    });
    const relay = {
      confirmed: async () => connection,
      isUnavailable: () => false,
    } as unknown as LocalRelay;
    const daemon = new LocalDaemon(manager, relay, {
      report: () => undefined,
      startController: async (owner) => {
        const endpoint = await startLocalController(owner);
        socketPath = endpoint.socketPath;
        controllerOnline();
        return endpoint;
      },
      startRemote: () => ({ close: async () => undefined }),
    });
    const abort = new AbortController();
    const running = runLocalService(f.records, release, {
      manager,
      daemon,
      signal: abort.signal,
      installation: async () => ({ active: release, staged: null, launcher: join(root, "launch") }),
      settle: async () => undefined,
    });
    void running.catch(() => undefined);
    try {
      await Promise.race([controllerReady, running]);
      while (!(await serviceFailure(state))) {
        await Promise.race([
          nextTurn(),
          running.then(() => {
            throw new Error("Owner exited before recording its native failure");
          }),
        ]);
      }
      expect(await serviceRequest(state)).toMatchObject({
        release,
        ready: false,
        failure: { code: "LOCAL_DOCKER_LOGIN_REQUIRED" },
      });
      const requestId = originalRequestId();
      const files = [
        { path: "standards/инструкция.md", content: "Owned archive bytes 🙂\n" },
        { path: "empty.txt", content: "" },
      ];
      const receipt = communicationOwnerReceiptSchema.parse(
        await controllerRequest(socketPath, "POST", "/v1/communication", {
          action: "publish",
          requestId,
          expectedScope: { kind: "controller", ...identity },
          source: { type: "materialize-text-set", files },
        }),
      );
      expect(receipt).toMatchObject({ requestId, state: "completed", outcome: { ok: true } });
      if (!receipt.outcome?.ok) throw new Error("Publication did not produce an archive");
      const file = receipt.outcome.result.file;
      const reference = parseCommunicationOwnerReference(file.referenceId);
      const archive = await publicationBytes(socketPath, reference.token);
      expect(archive.length).toBe(file.size);
      expect(await archiveFiles(archive)).toEqual(files);
      expect(
        await controllerRequest(socketPath, "GET", `/v1/communication/operations/${requestId}`),
      ).toMatchObject(receipt);
      expect(
        await controllerRequest(socketPath, "GET", `/v1/controller/operations/${unknownId}`),
      ).toMatchObject({ requestId: unknownId, state: "unconfirmed" });
      expect(await readFile(join(root, unknownKey))).toEqual(unknownBytes);
      expect(await f.records.get(f.space.id)).toEqual(f.space);
      expect(nativeAttempts).toBe(retainedFailure ? 0 : 1);
      await expect(manager.open()).rejects.toMatchObject({ code: "LOCAL_DOCKER_LOGIN_REQUIRED" });
      expect(nativeAttempts).toBe(retainedFailure ? 0 : 1);
      expect(await serviceFailure(state)).toEqual(
        retainedFailure
          ? oldFailure
          : { release, code: "LOCAL_DOCKER_LOGIN_REQUIRED", at: expect.any(Number) },
      );
      await expect(state.lock({ recoverStale: true })).rejects.toMatchObject({
        code: "LOCAL_ALREADY_RUNNING",
      });

      const pauseId = originalRequestId();
      await serviceRequest(state, "POST", "/v1/service/maintenance", {
        requestId: pauseId,
        release,
        action: "pause",
      });
      while ((await collectServiceMaintenance(state, pauseId))?.phase !== "paused") {
        await Promise.race([
          nextTurn(),
          running.then(() => {
            throw new Error("Owner exited before its maintenance pause");
          }),
        ]);
      }
      expect(await collectServiceMaintenance(state, pauseId)).toMatchObject({
        requestId: pauseId,
        phase: "paused",
        pause: true,
      });
      const releaseManagement = await state.lock({ recoverStale: true });
      await releaseManagement();
      expect(await readFile(join(root, unknownKey))).toEqual(unknownBytes);
      expect(await f.records.get(f.space.id)).toEqual(f.space);
    } finally {
      abort.abort();
      await running;
      await manager.release();
      await rm((await state.ipcDirectory()).root, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);
