import { afterEach, expect, test } from "@jest/globals";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { ControllerState } from "../../../packages/local/src/controller-state.js";
import { LocalRelay } from "../../../packages/local/src/relay.js";
import { LocalRecords } from "../../../packages/local/src/space-record.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { localFixture } from "../../integration/local/fixtures.js";
import type { LocalSetupAttempt } from "../../../packages/shared/src/codespaces/local-protocol.js";
import { findCredentialRequests } from "../../../packages/workspace-service/src/credential-request.mjs";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moira-git-custody-")));
  directories.push(root);
  const state = await PrivateState.open(root),
    local = await localFixture(state);
  local.policy.repositories[0].private = true;
  local.policy.repositories[0].allowPush = true;
  await state.write("policy.json", local.policy);
  const identity = {
    userId: "owner",
    deviceId: local.policy.deviceId,
    deviceGeneration: 1,
    connectionId: randomUUID(),
  };
  await state.write("connection.json", {
    ...identity,
    origin: "https://moira.example",
    credential: "d".repeat(43),
    pairingId: randomUUID(),
  });
  const binding = {
    ...identity,
    resourceId: randomUUID(),
    resourceGeneration: 9,
    routeGeneration: 3,
    repositoryId: local.space.repositoryId,
    operationMarker: local.space.operationMarker,
    localSpaceId: local.space.id,
    localGeneration: local.space.generation,
    creationClosed: false,
  };
  await new ControllerState(local.records).putBinding(binding);
  return { ...local, state, identity, binding };
}

test("setup custody is linked before issuance and exact-parent recovery excludes older and ordinary requests", async () => {
  const f = await fixture();
  const context = {
    spaceId: f.space.id,
    generation: f.space.generation,
    runtimeId: f.space.runtimeId!,
    repositoryId: f.space.repositoryId,
    operationMarker: f.space.operationMarker,
  };
  const attempt: LocalSetupAttempt = {
    ...context,
    requestId: `ws1-${randomUUID()}`,
    state: "preparing",
  };
  const older = `ws1-${randomUUID()}`,
    ordinary = `ws1-${randomUUID()}`;
  for (const [requestId, parentRequestId] of [
    [older, `ws1-${randomUUID()}`],
    [ordinary, undefined],
  ])
    await f.state.write(`credential-request-${requestId}.json`, {
      requestId,
      resourceId: f.binding.resourceId,
      resourceGeneration: 3,
      action: "fetch",
      state: parentRequestId ? "foreign-historical-state" : "unconfirmed",
      ...(parentRequestId ? { parentRequestId, localSetup: context } : {}),
    });
  await f.records.put({ ...f.space, setupAttempt: attempt });
  let issued = 0;
  let originalId = "";
  const relay = new LocalRelay(f.records, async (url, options) => {
    if (String(url).endsWith("/acquire")) {
      issued++;
      const input = JSON.parse(String(options?.body));
      originalId = input.requestId;
      expect(
        await f.state.read(`credential-request-${originalId}.json`, (value) => value),
      ).toMatchObject({
        requestId: originalId,
        parentRequestId: attempt.requestId,
        localSetup: context,
        state: "prepared",
      });
      throw new Error("Original acquire reply lost");
    }
    return Response.json({ success: true, data: { ...f.identity, status: "active" } });
  });
  await expect(
    relay.acquireGitCredential(f.space.id, f.space.repositoryId, "fetch", undefined, {
      requestId: attempt.requestId,
      generation: attempt.generation,
    }),
  ).rejects.toMatchObject({
    code: "WORKSPACE_OUTCOME_UNCONFIRMED",
  });
  const reopened = new LocalRelay(
    new LocalRecords(await PrivateState.open(f.state.root)),
    async (url) => {
      expect(String(url)).toContain(`/requests/${originalId}`);
      return Response.json({ state: "absent" });
    },
  );
  expect(
    (await reopened.setupCredentialRequests(attempt)).map((record) => record.requestId),
  ).toEqual([originalId]);
  await expect(reopened.requireSetupCredentialsSettled(attempt)).rejects.toMatchObject({
    code: "LOCAL_SETUP_INCOMPLETE",
  });
  await reopened.collectGitCredentialRequest(originalId);
  await expect(reopened.requireSetupCredentialsSettled(attempt)).resolves.toBeUndefined();
  expect(await f.state.read(`credential-request-${older}.json`, (value) => value)).toMatchObject({
    state: "foreign-historical-state",
  });
  expect(await f.state.read(`credential-request-${ordinary}.json`, (value) => value)).toMatchObject(
    { state: "unconfirmed" },
  );
  expect(issued).toBe(1);
});

test("a stale setup marker is refused before external authority or credential issuance", async () => {
  const f = await fixture();
  let requests = 0;
  const relay = new LocalRelay(f.records, async () => {
    requests++;
    throw new Error("Stale setup contacted authority");
  });
  await expect(
    relay.acquireGitCredential(f.space.id, f.space.repositoryId, "fetch", undefined, {
      requestId: `ws1-${randomUUID()}`,
      generation: f.space.generation,
    }),
  ).rejects.toMatchObject({ code: "LOCAL_IDENTITY_CHANGED" });
  expect(requests).toBe(0);
  expect(await f.state.keys("credential-request-")).toEqual([]);
});

test.each(["state", "requestId", "context"] as const)(
  "exact setup lookup refuses corrupted selected %s rather than dropping its custody",
  async (change) => {
    const f = await fixture();
    const attempt: LocalSetupAttempt = {
      requestId: `ws1-${randomUUID()}`,
      spaceId: f.space.id,
      generation: f.space.generation,
      runtimeId: f.space.runtimeId!,
      repositoryId: f.space.repositoryId,
      operationMarker: f.space.operationMarker,
      state: "completed",
    };
    const requestId = `ws1-${randomUUID()}`;
    await f.state.write(`credential-request-${requestId}.json`, {
      requestId: change === "requestId" ? `ws1-${randomUUID()}` : requestId,
      parentRequestId: attempt.requestId,
      localSetup: {
        spaceId: f.space.id,
        generation: attempt.generation,
        runtimeId: change === "context" ? "foreign-vm" : attempt.runtimeId,
        repositoryId: attempt.repositoryId,
        operationMarker: attempt.operationMarker,
      },
      resourceId: f.binding.resourceId,
      resourceGeneration: 3,
      action: "fetch",
      state: change === "state" ? "unrecognized-selected-state" : "unconfirmed",
    });
    let network = 0;
    const relay = new LocalRelay(f.records, async () => {
      network++;
      throw new Error("Query contacted issuer");
    });
    await expect(relay.requireSetupCredentialsSettled(attempt)).rejects.toThrow();
    expect(network).toBe(0);
    expect(await f.state.keys("credential-request-")).toEqual([
      `credential-request-${requestId}.json`,
    ]);
  },
);

test("a setup child journal write failure prevents external issuance", async () => {
  const f = await fixture();
  const attempt: LocalSetupAttempt = {
    requestId: `ws1-${randomUUID()}`,
    spaceId: f.space.id,
    generation: f.space.generation,
    runtimeId: f.space.runtimeId!,
    repositoryId: f.space.repositoryId,
    operationMarker: f.space.operationMarker,
    state: "preparing",
  };
  await f.records.put({ ...f.space, setupAttempt: attempt });
  const write = f.state.write.bind(f.state);
  f.state.write = async (key, value) => {
    if (key.startsWith("credential-request-")) throw new Error("Controlled durable write refusal");
    return write(key, value);
  };
  let issued = 0;
  const relay = new LocalRelay(f.records, async (url) => {
    if (String(url).endsWith("/acquire")) {
      issued++;
      throw new Error("Unjournaled issuance");
    }
    return Response.json({ success: true, data: { ...f.identity, status: "active" } });
  });
  await expect(
    relay.acquireGitCredential(f.space.id, f.space.repositoryId, "fetch", undefined, {
      requestId: attempt.requestId,
      generation: attempt.generation,
    }),
  ).rejects.toThrow("Controlled durable write refusal");
  expect(issued).toBe(0);
  expect(await f.state.keys("credential-request-")).toEqual([]);
});

test("a selected child disappearing during exact lookup is not proof of settled custody", async () => {
  const requestId = `ws1-${randomUUID()}`,
    parentRequestId = `ws1-${randomUUID()}`;
  let reads = 0;
  await expect(
    findCredentialRequests(
      {
        requestIds: async () => [requestId],
        read: async () => (++reads === 1 ? { parentRequestId } : null),
        write: async () => {
          throw new Error("Lookup must not write");
        },
      },
      parentRequestId,
    ),
  ).rejects.toThrow("Security parent changed");
});

test("known scoped acquisition rechecks the same original security ID and stable route, then disposes after local work stops", async () => {
  const f = await fixture();
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const credentialId = randomUUID();
  const expiresAt = Date.now() + 3600000;
  const fetcher = async (url: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(url)).pathname,
      body = JSON.parse(String(options?.body));
    calls.push({ path, body });
    const child = {
      credentialId,
      token: "ghu_scoped_child",
      expiresAt,
      useUntil: expiresAt,
      repositoryFullName: f.policy.repositories[0].fullName,
    };
    const data = path.endsWith("/heartbeat")
      ? { ...f.identity, status: "active" }
      : path.endsWith("/acquire")
        ? child
        : path.includes("/requests/")
          ? { state: "live", credential: child }
          : {};
    return new Response(
      JSON.stringify(path.endsWith("/heartbeat") ? { success: true, data } : data),
      { status: 200 },
    );
  };
  const lease = await new LocalRelay(f.records, fetcher as typeof fetch).acquireGitCredential(
    f.space.id,
    f.space.repositoryId,
    "push",
  );
  await lease.validate();
  const observer = new LocalRelay(f.records, fetcher as typeof fetch);
  const [active] = await observer.pendingGitCredentialRequests();
  const priorCalls = calls.length;
  expect(await observer.collectGitCredentialRequest(active.requestId)).toEqual(active);
  expect(calls).toHaveLength(priorCalls);
  const issued = calls.filter((call) => call.path.endsWith("/acquire"));
  expect(issued).toHaveLength(1);
  expect(issued[0].body).toMatchObject({
    resourceId: f.binding.resourceId,
    resourceGeneration: 3,
    action: "push",
  });
  expect(issued[0].body.requestId).toMatch(/^ws1-[a-f0-9-]{36}$/);
  expect(calls.find((call) => call.path.includes("/requests/"))?.body).toEqual(issued[0].body);
  f.policy.enabled = false;
  await f.state.write("policy.json", f.policy);
  f.space.desiredState = "stopped";
  await f.records.put(f.space);
  await lease.dispose();
  expect(calls.at(-1)).toEqual({
    path: `/api/codespaces/github/credentials/${credentialId}/release`,
    body: { resourceId: f.binding.resourceId, resourceGeneration: 3 },
  });
  expect((await f.state.keys("git-")).length).toBe(0);
  expect(JSON.stringify(await f.state.read("connection.json", (value) => value))).not.toContain(
    "ghu_scoped_child",
  );
  expect(
    await new LocalRelay(f.records, fetcher as typeof fetch).pendingGitCredentialRequests(),
  ).toEqual([]);
});

test("exclusive absent-owner runner proof marks an orphan known child for collect-only disposal", async () => {
  const f = await fixture();
  const requestId = `ws1-${randomUUID()}`,
    credentialId = randomUUID();
  await f.state.write(`credential-request-${requestId}.json`, {
    requestId,
    credentialId,
    resourceId: f.binding.resourceId,
    resourceGeneration: 3,
    action: "fetch",
    state: "live",
  });
  const manager = new LocalManager(f.records);
  try {
    await manager.holdRunnerLock();
    const relay = new LocalRelay(f.records);
    expect((await relay.pendingGitCredentialRequests())[0]).toMatchObject({
      requestId,
      credentialId,
      state: "dispose_pending",
    });
  } finally {
    await manager.close();
  }
});

test("Local native-owner absence does not dispose a GitHub SSH provisioning child with different physical custody", async () => {
  const f = await fixture(),
    requestId = `ws1-${randomUUID()}`,
    credentialId = randomUUID();
  const record = {
    requestId,
    credentialId,
    resourceId: randomUUID(),
    resourceGeneration: 2,
    action: "codespaces_provision",
    state: "live",
  };
  await f.state.write(`credential-request-${requestId}.json`, record);
  const manager = new LocalManager(f.records);
  try {
    await manager.holdRunnerLock();
    let issuerCalls = 0;
    const relay = new LocalRelay(f.records, async () => {
      issuerCalls++;
      throw new Error("Local absence must not release SSH custody");
    });
    expect(await relay.collectGitCredentialRequest(requestId)).toEqual(record);
    expect(await f.state.read(`credential-request-${requestId}.json`, (value) => value)).toEqual(
      record,
    );
    expect(issuerCalls).toBe(0);
  } finally {
    await manager.close();
  }
});

test("unknown issuance is attempted once and never becomes an implicit mint retry or host token file", async () => {
  const f = await fixture();
  let attempts = 0;
  const fetcher = async (url: string | URL | Request) => {
    if (new URL(String(url)).pathname.endsWith("/acquire")) {
      attempts++;
      throw Error("Controlled transport loss");
    }
    return new Response(
      JSON.stringify({ success: true, data: { ...f.identity, status: "active" } }),
    );
  };
  await expect(
    new LocalRelay(f.records, fetcher as typeof fetch).acquireGitCredential(
      f.space.id,
      f.space.repositoryId,
      "push",
    ),
  ).rejects.toMatchObject({ code: "WORKSPACE_OUTCOME_UNCONFIRMED" });
  expect(attempts).toBe(1);
  expect(await f.state.keys("git-")).toEqual([]);
});

test("caller cancellation retains original issuance custody without a synthetic relay deadline", async () => {
  const f = await fixture();
  const abort = new AbortController();
  let issued!: () => void;
  const submitted = new Promise<void>((resolve) => {
    issued = resolve;
  });
  const signals: Array<AbortSignal | null | undefined> = [];
  let attempts = 0;
  const relay = new LocalRelay(f.records, async (url, options) => {
    signals.push(options?.signal);
    if (String(url).endsWith("/acquire")) {
      attempts++;
      issued();
      return new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
          once: true,
        });
      });
    }
    return Response.json({ success: true, data: { ...f.identity, status: "active" } });
  });
  const pending = relay.acquireGitCredential(
    f.space.id,
    f.space.repositoryId,
    "push",
    abort.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: "WORKSPACE_OUTCOME_UNCONFIRMED" });
  await submitted;
  abort.abort(new Error("Original caller cancelled"));
  await rejected;
  expect(signals.every((signal) => signal === abort.signal)).toBe(true);
  expect(attempts).toBe(1);
  expect(await relay.pendingGitCredentialRequests()).toEqual([
    expect.objectContaining({ state: "unconfirmed", action: "push" }),
  ]);
});

test.each([
  "SCOPED_CREDENTIAL_CUSTODY_UNCONFIRMED",
  "SCOPED_CREDENTIAL_DISPOSAL_PENDING",
  "SCOPED_CREDENTIAL_FUTURE_OUTCOME",
])(
  "HTTP 503 %s retains the original security nonce for collect-only recovery after restart",
  async (code) => {
    const f = await fixture();
    let acquisitions = 0;
    let original: Record<string, unknown> | undefined;
    const fetcher = async (url: string | URL | Request, options?: RequestInit) => {
      if (new URL(String(url)).pathname.endsWith("/acquire")) {
        acquisitions++;
        original = JSON.parse(String(options?.body));
        return new Response(JSON.stringify({ error: { code } }), { status: 503 });
      }
      return new Response(
        JSON.stringify({ success: true, data: { ...f.identity, status: "active" } }),
      );
    };
    const relay = new LocalRelay(f.records, fetcher as typeof fetch);
    const error = await relay
      .acquireGitCredential(f.space.id, f.space.repositoryId, "push")
      .catch((value) => value);
    expect(error).toMatchObject({ code, securityRequestId: original?.requestId });
    const stored = await f.state.read(
      `credential-request-${original?.requestId}.json`,
      (value) => value,
    );
    expect(stored).toMatchObject({ requestId: original?.requestId, state: "unconfirmed" });
    expect(error.message).toContain("unconfirmed");
    expect(error.message).not.toContain("refused");
    const reopened = new LocalRecords(await PrivateState.open(f.state.root));
    const collected: Array<{ path: string; body: unknown }> = [];
    const recoveryFetch = async (url: string | URL | Request, options?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      collected.push({ path, body: JSON.parse(String(options?.body)) });
      if (!path.includes("/requests/"))
        throw Error("Recovery dispatched issuance or Git instead of collect");
      return new Response(JSON.stringify({ state: "unconfirmed" }));
    };
    const recovery = new LocalRelay(reopened, recoveryFetch as typeof fetch);
    expect(await recovery.pendingGitCredentialRequests()).toEqual([stored]);
    expect(await recovery.collectGitCredentialRequest(String(original?.requestId))).toEqual(stored);
    expect(collected).toEqual([
      {
        path: `/api/codespaces/github/credentials/requests/${original?.requestId}`,
        body: original,
      },
    ]);
    expect(acquisitions).toBe(1);
  },
);

test.each(["live", "absent", "unconfirmed"] as const)(
  "restart collects a lost issuance as %s without minting or replaying Git",
  async (outcome) => {
    const f = await fixture();
    let acquireCalls = 0;
    const firstFetcher = async (url: string | URL | Request) => {
      if (new URL(String(url)).pathname.endsWith("/acquire")) {
        acquireCalls++;
        throw Error("Lost reply");
      }
      return new Response(
        JSON.stringify({ success: true, data: { ...f.identity, status: "active" } }),
      );
    };
    const relay = new LocalRelay(f.records, firstFetcher as typeof fetch);
    await expect(
      relay.acquireGitCredential(f.space.id, f.space.repositoryId, "push"),
    ).rejects.toMatchObject({ code: "WORKSPACE_OUTCOME_UNCONFIRMED" });
    const [original] = await relay.pendingGitCredentialRequests();
    expect(original.state).toBe("unconfirmed");
    const reopened = await PrivateState.open(f.state.root);
    const records = new LocalRecords(reopened);
    const calls: Array<{ path: string; body: unknown }> = [];
    const credentialId = randomUUID();
    const expiresAt = Date.now() + 3600000;
    const fetcher = async (url: string | URL | Request, options?: RequestInit) => {
      const path = new URL(String(url)).pathname,
        body = JSON.parse(String(options?.body));
      calls.push({ path, body });
      if (path.endsWith("/acquire")) throw Error("Recovery must never mint");
      return new Response(
        JSON.stringify(
          path.endsWith("/release")
            ? { released: true }
            : outcome === "live"
              ? {
                  state: "live",
                  credential: {
                    credentialId,
                    token: "ghu_scoped_child",
                    expiresAt,
                    useUntil: expiresAt,
                    repositoryFullName: f.policy.repositories[0].fullName,
                  },
                }
              : { state: outcome },
        ),
      );
    };
    const recovered = new LocalRelay(records, fetcher as typeof fetch);
    expect(await recovered.pendingGitCredentialRequests()).toEqual([original]);
    const result = await recovered.collectGitCredentialRequest(original.requestId);
    expect(result?.state).toBe(outcome === "live" ? "disposed" : outcome);
    expect(calls[0]).toEqual({
      path: `/api/codespaces/github/credentials/requests/${original.requestId}`,
      body: {
        requestId: original.requestId,
        resourceId: f.binding.resourceId,
        resourceGeneration: 3,
        action: "push",
      },
    });
    expect(calls).toHaveLength(outcome === "live" ? 2 : 1);
    expect(acquireCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("ghu_scoped_child");
    if (outcome !== "unconfirmed") {
      expect(await recovered.pendingGitCredentialRequests()).toEqual([]);
      await recovered.collectGitCredentialRequest(original.requestId);
      expect(calls).toHaveLength(outcome === "live" ? 2 : 1);
    } else expect(await recovered.pendingGitCredentialRequests()).toEqual([original]);
  },
);
