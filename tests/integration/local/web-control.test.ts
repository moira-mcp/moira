import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  LocalWebControl,
  LocalCompanion,
  controlSettings,
} from "../../../packages/local/src/web-control.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalRelay } from "../../../packages/local/src/relay.js";
import { RequestJournal } from "../../../packages/local/src/journal.js";
import { localEnvelopeSchema } from "../../../packages/local/src/rpc.js";
import { canonicalJson } from "../../../packages/shared/src/utils/canonical-json.js";
import { GiB, LocalRefusal, publicPolicy } from "../../../packages/local/src/policy.js";
import { localFixture } from "./fixtures.js";
import {
  MAX_LOCAL_WORK_LEASE_MS,
  type LocalControlCeiling,
  type LocalDeviceControlView,
} from "../../../packages/shared/src/codespaces/local-management-types.js";
let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "ml-control-")));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const state = await PrivateState.open(directory),
    local = await localFixture(state);
  const connection = {
    origin: "https://moira.example",
    credential: randomBytes(32).toString("base64url"),
    deviceId: local.policy.deviceId,
    userId: "owner",
    deviceGeneration: 1,
    connectionId: randomUUID(),
    pairingId: randomUUID(),
  };
  await state.write("connection.json", connection);
  const ceiling: LocalControlCeiling = {
    cpuCores: 4,
    memoryBytes: 8 * GiB,
    storageBytes: 64 * GiB,
    dockerBytes: 8 * GiB,
    maxLeaseMs: MAX_LOCAL_WORK_LEASE_MS,
  };
  return { ...local, state, connection, ceiling };
}
describe("Locally pinned owner web control", () => {
  test.each(["existing", "created"])(
    "applied %s delegation and repository append preserve an existing live space and broker capability",
    async (origin) => {
      const f = await fixture();
      const manager = new LocalManager(f.records);
      const control = new LocalWebControl(f.records);
      await control.optIn(f.connection, f.ceiling, true);
      const beforeSpace = await f.records.get(f.space.id);
      const beforeGrant = await f.records.authorize(f.authorization);
      const delegation = {
        githubUserId: "42",
        owner: "owner",
        allowExistingPrivate: origin === "existing",
        allowNewPrivate: origin === "created",
        allowPush: true,
      };
      const base: LocalDeviceControlView = {
        optedIn: true,
        revision: 1,
        appliedRevision: 0,
        status: "pending",
        settings: { ...controlSettings(f.policy), agentRepositoryManagement: delegation },
        ceiling: f.ceiling,
        error: null,
      };
      try {
        expect(await control.apply(base, manager)).toBe("live");
        const repository = {
          id: randomUUID(),
          fullName: "owner/another",
          private: true,
          allowPush: true,
          allowDelete: false,
          allowPullRequests: false,
        };
        const view = {
          ...base,
          revision: 2,
          appliedRevision: 1,
          settings: { ...base.settings, repositories: [...base.settings.repositories, repository] },
          repositoryAdmissions: [
            {
              requestId: randomUUID(),
              githubRepositoryId: "77",
              localRepositoryId: repository.id,
              revision: 2,
              deviceGeneration: 1,
              connectionId: f.connection.connectionId,
              repository,
              ...(origin === "created" ? { creationRequestId: randomUUID() } : {}),
            },
          ],
        };
        expect(await control.apply(view, manager)).toBe("live");
        expect(await f.records.get(f.space.id)).toEqual(beforeSpace);
        expect((await f.records.authorize(f.authorization))?.repository).toEqual(
          beforeGrant?.repository,
        );
        expect((await f.records.policy()).runtime).toEqual(f.policy.runtime);
        expect((await f.records.policy()).leaseUntil).toBe(f.policy.leaseUntil);
        expect(await control.report(f.connection)).toMatchObject({
          appliedRevision: 2,
          settings: {
            agentRepositoryManagement: delegation,
            repositories: view.settings.repositories,
          },
        });
        expect(await control.apply(view, manager)).toBe(false);
        expect((await f.records.policy()).repositories).toHaveLength(2);
      } finally {
        await manager.close();
      }
    },
  );
  test("missing delegation or changed old rights are refused without disabling existing work", async () => {
    const f = await fixture();
    const manager = new LocalManager(f.records);
    const control = new LocalWebControl(f.records);
    await control.optIn(f.connection, f.ceiling, true);
    const beforeSpace = await f.records.get(f.space.id);
    const repository = {
      id: randomUUID(),
      fullName: "owner/another",
      private: true,
      allowPush: true,
      allowDelete: false,
    };
    const view: LocalDeviceControlView = {
      optedIn: true,
      revision: 1,
      appliedRevision: 0,
      status: "pending",
      settings: {
        ...controlSettings(f.policy),
        repositories: [...f.policy.repositories, repository],
      },
      ceiling: f.ceiling,
      error: null,
      repositoryAdmissions: [
        {
          requestId: randomUUID(),
          githubRepositoryId: "77",
          localRepositoryId: repository.id,
          revision: 1,
          deviceGeneration: 1,
          connectionId: f.connection.connectionId,
          repository,
        },
      ],
    };
    try {
      expect(await control.apply(view, manager)).toBe(false);
      expect(await f.records.policy()).toEqual(f.policy);
      expect(await f.records.get(f.space.id)).toEqual(beforeSpace);
      expect(await f.state.read("control-intent.json", (value) => value)).toBeNull();
      expect(
        await control.apply(
          {
            ...view,
            revision: 2,
            settings: {
              ...view.settings,
              repositories: [{ ...f.policy.repositories[0], allowPush: true }, repository],
            },
            repositoryAdmissions: [{ ...view.repositoryAdmissions![0], revision: 2 }],
          },
          manager,
        ),
      ).toBe(false);
      expect(await f.records.policy()).toEqual(f.policy);
      expect(await f.records.get(f.space.id)).toEqual(beforeSpace);
    } finally {
      await manager.close();
    }
  });
  test("a retained completed control intent cannot block a different subsequent owner revision", async () => {
    const f = await fixture();
    f.space.desiredState = "stopped";
    f.space.phase = "stopped";
    await f.records.put(f.space);
    const manager = new LocalManager(f.records);
    const control = new LocalWebControl(f.records, {
      replacePolicy: async (records, next) => {
        await records.state.write("policy.json", next);
      },
    });
    await control.optIn(f.connection, f.ceiling, true);
    const settings = controlSettings(f.policy);
    const view: LocalDeviceControlView = {
      optedIn: true,
      revision: 1,
      appliedRevision: 0,
      status: "pending",
      settings,
      ceiling: f.ceiling,
      error: null,
    };
    try {
      expect(await control.apply(view, manager)).toBe(true);
      expect(await control.report(f.connection)).toMatchObject({ appliedRevision: 1 });
      // The ACK persisted; interruption prevented only the final intent deletion.
      await f.state.write("control-intent.json", { revision: 1, settings });
      expect(
        await control.apply(
          {
            ...view,
            revision: 2,
            appliedRevision: 1,
            settings: { ...settings, label: "New owner settings", cpuCores: 2 },
          },
          manager,
        ),
      ).toBe(true);
      expect(await control.report(f.connection)).toMatchObject({
        appliedRevision: 2,
        settings: { label: "New owner settings", cpuCores: 2 },
      });
      expect(await f.state.read("control-intent.json", (value) => value)).toBeNull();
    } finally {
      await manager.close();
    }
  });
  test("idle expired companion accepts a web renewal then returns to management-only on expiry", async () => {
    const f = await fixture();
    f.policy.enabled = false;
    f.policy.leaseUntil = 0;
    await f.state.write("policy.json", f.policy);
    const manager = new LocalManager(f.records);
    let opened = 0,
      claims = 0,
      heartbeats = 0;
    manager.open = async () => {
      opened++;
    };
    manager.stopWork = async () => {
      const s = await f.records.get(f.space.id);
      s!.desiredState = "stopped";
      s!.phase = "stopped";
      await f.records.put(s!);
    };
    const control = new LocalWebControl(f.records, {
      replacePolicy: async (records, next) => {
        await records.state.write("policy.json", next);
      },
    });
    await control.optIn(f.connection, f.ceiling, true);
    let desired: LocalDeviceControlView | undefined;
    const transport: typeof fetch = async (url) => {
      if (String(url).endsWith("/heartbeat")) {
        heartbeats++;
        return Response.json({
          success: true,
          data: {
            ...f.connection,
            status: "active",
            policy: publicPolicy(await f.records.policy()),
            ...(desired ? { control: desired } : {}),
          },
        });
      }
      if (String(url).endsWith("/relay/claim")) {
        claims++;
        return Response.json({ success: true, data: { requests: [], maxPartBytes: 4096 } });
      }
      throw new Error("unexpected fixture route");
    };
    const companion = new LocalCompanion(manager, new LocalRelay(f.records, transport), control);
    try {
      expect(await companion.cycle()).toBe(false);
      expect(opened).toBe(0);
      expect(claims).toBe(0);
      desired = {
        optedIn: true,
        revision: 1,
        appliedRevision: 0,
        status: "pending",
        settings: {
          ...controlSettings(f.policy),
          enabled: true,
          leaseUntil: Date.now() + MAX_LOCAL_WORK_LEASE_MS - 1000,
        },
        ceiling: f.ceiling,
        error: null,
      };
      expect(await companion.cycle()).toBe(true);
      expect(opened).toBe(1);
      expect(claims).toBe(1);
      const expired = await f.records.policy();
      expired.leaseUntil = Date.now() - 1;
      await f.state.write("policy.json", expired);
      expect(await companion.cycle()).toBe(false);
      expect(opened).toBe(1);
      expect(claims).toBe(2);
      expect(heartbeats).toBe(6);
      expect((await f.records.get(f.space.id))?.desiredState).toBe("stopped");
    } finally {
      await manager.close();
    }
  });
  test("typed resize preflight refusal permits a corrected revision while uncertain native effects keep their intent", async () => {
    const f = await fixture();
    f.space.desiredState = "stopped";
    f.space.phase = "stopped";
    await f.records.put(f.space);
    const manager = new LocalManager(f.records);
    let attempts = 0;
    const control = new LocalWebControl(f.records, {
      resize: async () => {
        attempts++;
        throw new LocalRefusal("LOCAL_HOST_STORAGE_LOW", "Not enough host storage.");
      },
      replacePolicy: async (records, next) => {
        await records.state.write("policy.json", next);
      },
    });
    await control.optIn(f.connection, f.ceiling, true);
    const view: LocalDeviceControlView = {
      optedIn: true,
      revision: 1,
      appliedRevision: 0,
      status: "pending",
      settings: { ...controlSettings(f.policy), storageBytes: 64 * GiB },
      ceiling: f.ceiling,
      error: null,
    };
    try {
      expect(await control.apply(view, manager)).toBe(false);
      expect(attempts).toBe(1);
      expect(await f.state.read("control-intent.json", (value) => value)).toBeNull();
      expect(
        await control.apply(
          { ...view, revision: 2, settings: { ...controlSettings(f.policy), enabled: false } },
          manager,
        ),
      ).toBe(true);
      expect(await control.report(f.connection)).toMatchObject({ appliedRevision: 2 });
    } finally {
      await manager.close();
    }
  });
  test("initial private Git requires our known creating manifest and exact live relay intent, not same-name adoption", async () => {
    const f = await fixture();
    f.space.phase = "creating";
    await f.records.put(f.space);
    const resourceId = randomUUID(),
      requestId = randomUUID();
    const message = localEnvelopeSchema.parse({
      version: 1,
      id: requestId,
      expiresAt: Date.now() + 60000,
      request: {
        action: "create",
        repositoryId: f.space.repositoryId,
        operationMarker: f.space.operationMarker,
        ref: f.space.ref,
      },
    });
    const digest = createHash("sha256").update(canonicalJson(message)).digest("hex");
    let admitted!: () => void, release!: () => void;
    const entered = new Promise<void>((done) => {
      admitted = done;
    });
    const held = new Promise<void>((done) => {
      release = done;
    });
    const accepted = new RequestJournal(f.state).run(
      requestId,
      message.expiresAt,
      message.request,
      async () => {
        admitted();
        await held;
        return { ok: true, result: { spaceId: f.space.id } };
      },
    );
    await entered;
    await f.state.write(`relay-space-${resourceId}.json`, {
      resourceId,
      deviceId: f.connection.deviceId,
      userId: f.connection.userId,
      connectionId: f.connection.connectionId,
      deviceGeneration: 1,
      serverGeneration: 4,
      localSpaceId: null,
      localGeneration: null,
      createMarker: f.space.operationMarker,
      repositoryId: f.space.repositoryId,
      createRequestId: requestId,
      createDigest: digest,
    });
    await f.state.write(`relay-request-${requestId}.json`, {
      digest,
      resourceId,
      deviceGeneration: 1,
      connectionId: f.connection.connectionId,
      serverGeneration: 4,
      message,
    });
    const transport: typeof fetch = async () =>
      Response.json({
        success: true,
        data: { ...f.connection, status: "active", policy: publicPolicy(await f.records.policy()) },
      });
    const relay = new LocalRelay(f.records, transport);
    try {
      expect(await relay.gitAuthority(f.space.id, f.space.repositoryId)).toMatchObject({
        resourceId,
        resourceGeneration: 4,
      });
      f.space.runtimeId = null;
      await f.records.put(f.space);
      await expect(relay.gitAuthority(f.space.id, f.space.repositoryId)).rejects.toMatchObject({
        code: "LOCAL_CREATE_UNKNOWN",
      });
    } finally {
      release();
      await accepted;
    }
    f.space.runtimeId = "known-fixture-runtime";
    await f.records.put(f.space);
    await f.state.remove(`relay-request-${requestId}.json`);
    await expect(relay.gitAuthority(f.space.id, f.space.repositoryId)).rejects.toMatchObject({
      code: "LOCAL_CREATE_UNKNOWN",
    });
  });
  test("opt-in is explicit, keeps existing connection, and expired disabled heartbeat reports without SDK work", async () => {
    const f = await fixture(),
      control = new LocalWebControl(f.records);
    const original = await readFile(join(directory, "connection.json"));
    await expect(control.optIn(f.connection, f.ceiling, false)).rejects.toMatchObject({
      code: "LOCAL_CONTROL_CONFIRM",
    });
    f.policy.enabled = false;
    f.policy.leaseUntil = 0;
    await f.state.write("policy.json", f.policy);
    await control.optIn(f.connection, f.ceiling, true);
    let sent: unknown;
    const transport: typeof fetch = async (_url, options) => {
      sent = JSON.parse(String(options?.body));
      return Response.json({
        success: true,
        data: { ...f.connection, status: "active", policy: publicPolicy(await f.records.policy()) },
      });
    };
    await new LocalRelay(f.records, transport).confirmed();
    expect(sent).toMatchObject({
      policy: { enabled: false, leaseUntil: 0 },
      control: { appliedRevision: 0, ceiling: f.ceiling },
    });
    expect(await readFile(join(directory, "connection.json"))).toEqual(original);
    await expect(control.report({ ...f.connection, userId: "other" })).rejects.toMatchObject({
      code: "LOCAL_IDENTITY_CHANGED",
    });
  });
  test("changing defaults occurs after confirmed stop, preserves old VM admission and acknowledges only after policy commit", async () => {
    const f = await fixture();
    let settled = false;
    const manager = new LocalManager(f.records);
    // Controlled physical boundary only; native SDK ownership is covered by its own consumer tests.
    manager.stopWork = async () => {
      const space = await f.records.get(f.space.id);
      space!.desiredState = "stopped";
      space!.phase = "stopped";
      space!.generation++;
      await f.records.put(space!);
      settled = true;
    };
    const control = new LocalWebControl(f.records, {
      replacePolicy: async (records, next) => {
        expect(settled).toBe(true);
        expect((await f.state.read("web-control.json", (value) => value)) as object).toMatchObject({
          appliedRevision: 0,
        });
        await records.state.write("policy.json", next);
      },
    });
    await control.optIn(f.connection, f.ceiling, true);
    const settings = {
      ...controlSettings(f.policy),
      cpuCores: 4,
      memoryBytes: 8 * GiB,
      leaseUntil: Date.now() + MAX_LOCAL_WORK_LEASE_MS - 1000,
    };
    try {
      expect(
        await control.apply(
          {
            optedIn: true,
            revision: 1,
            appliedRevision: 0,
            status: "pending",
            settings,
            ceiling: f.ceiling,
            error: null,
          },
          manager,
        ),
      ).toBe(true);
      expect((await f.records.policy()).runtime).toMatchObject({
        cpuCores: 4,
        memoryBytes: 8 * GiB,
      });
      expect((await f.records.get(f.space.id))?.admittedMachine).toEqual({
        cpuCores: 1,
        memoryBytes: GiB,
        dockerBytes: 4 * GiB,
      });
      expect(await control.report(f.connection)).toMatchObject({
        appliedRevision: 1,
        settings: { cpuCores: 4 },
      });
    } finally {
      await manager.close();
    }
  });
  test("invalid ceiling and failed storage effects never acknowledge or enable work", async () => {
    const f = await fixture();
    f.space.desiredState = "stopped";
    f.space.phase = "stopped";
    await f.records.put(f.space);
    const manager = new LocalManager(f.records);
    let effects = 0;
    const control = new LocalWebControl(f.records, {
      resize: async () => {
        effects++;
        throw new LocalRefusal("LOCAL_STORAGE_UNSAFE", "Owned image resize did not settle.");
      },
      replacePolicy: async () => {
        throw new Error("must not commit");
      },
    });
    await control.optIn(f.connection, f.ceiling, true);
    const view = {
      optedIn: true,
      revision: 1,
      appliedRevision: 0,
      status: "pending" as const,
      settings: { ...controlSettings(f.policy), cpuCores: 5 },
      ceiling: f.ceiling,
      error: null,
    };
    expect(await control.apply(view, manager)).toBe(false);
    expect(effects).toBe(0);
    try {
      expect(
        await control.apply(
          {
            ...view,
            revision: 2,
            settings: { ...controlSettings(f.policy), storageBytes: 64 * GiB },
          },
          manager,
        ),
      ).toBe(false);
      expect(effects).toBe(1);
      expect((await f.records.policy()).enabled).toBe(false);
      expect(await control.report(f.connection)).toMatchObject({
        appliedRevision: 0,
        rejectedRevision: 2,
        error: { code: "LOCAL_STORAGE_UNSAFE" },
      });
      expect(
        await control.apply(
          {
            ...view,
            revision: 3,
            settings: {
              ...controlSettings(f.policy),
              storageBytes: 64 * GiB,
              leaseUntil: Date.now() + MAX_LOCAL_WORK_LEASE_MS - 1000,
            },
          },
          manager,
        ),
      ).toBe(false);
      expect(effects).toBe(2);
      expect(await control.report(f.connection)).toMatchObject({
        appliedRevision: 0,
        rejectedRevision: 3,
        error: { code: "LOCAL_STORAGE_UNSAFE" },
      });
      expect(await f.state.read("control-intent.json", (value) => value)).toMatchObject({
        revision: 3,
      });
    } finally {
      await manager.close();
    }
  });
});
