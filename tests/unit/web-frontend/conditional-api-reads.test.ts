import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { MoiraApiClient } from "../../../packages/web-frontend/src/services/api-client";
import { ConditionalReadStore } from "../../../packages/web-frontend/src/services/conditional-read-store";
import {
  observeReadSession,
  observeReadCapabilities,
  retireReads,
  runReadInvalidatingEffect,
} from "../../../packages/web-frontend/src/services/read-scope";

const originalAdapter = axios.defaults.adapter;
beforeEach(() => {
  retireReads();
  observeReadSession("reader", "session-a");
});
afterEach(() => {
  jest.restoreAllMocks();
  axios.defaults.adapter = originalAdapter;
  observeReadSession(null, null);
});

function reply(config: InternalAxiosRequestConfig, data: unknown, etag = 'W/"a"', status = 200) {
  return {
    config,
    status,
    statusText: status === 304 ? "Not Modified" : "OK",
    headers: { etag },
    data: status === 304 ? "" : { success: true, data },
  };
}

test("warm reads validate source and restore 304; a separate source mutation changes the next result", async () => {
  let content = "first";
  const requests: InternalAxiosRequestConfig[] = [];
  axios.defaults.adapter = async (config) => {
    requests.push(config);
    const etag = `W/"${content}"`;
    return reply(
      config,
      { notes: [{ preview: content }], total: 1, allTags: [] },
      etag,
      config.headers.get("If-None-Match") === etag ? 304 : 200,
    );
  };
  const client = new MoiraApiClient();
  const first = await client.getNotes();
  expect((await client.getNotes()).notes).toEqual(first.notes);
  expect(requests[1].headers.get("If-None-Match")).toBe('W/"first"');
  expect(requests[1].headers.get("Cache-Control")).toBeUndefined();
  // Another process changed the source; no browser invalidation notification is provided.
  content = "MCP changed it";
  expect((await client.getNotes()).notes[0].preview).toBe(content);
  expect(requests).toHaveLength(3);
});

test("same canonical concurrent queries share a read but distinct filters never share data", async () => {
  let dispatches = 0;
  axios.defaults.adapter = async (config) => {
    dispatches++;
    await Promise.resolve();
    return reply(config, { playbooks: [{ name: config.params?.search }], total: 1 });
  };
  const client = new MoiraApiClient();
  const [a, b, other] = await Promise.all([
    client.getPlaybooks({ search: "one", limit: 5 }),
    client.getPlaybooks({ limit: 5, search: "one" }),
    client.getPlaybooks({ search: "two", limit: 5 }),
  ]);
  expect(a).toEqual(b);
  expect(other.playbooks).not.toEqual(a.playbooks);
  expect(dispatches).toBe(2);
});

test.each(["account", "credential", "capability"])(
  "a retired %s request cannot replay under the replacement authority",
  async (change) => {
    let finish!: () => void;
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    axios.defaults.adapter = async (config) => {
      calls++;
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return reply(config, { notes: [{ preview: "former authority" }] });
    };
    const client = new MoiraApiClient();
    const pending = client.getNotes();
    const rejected = expect(pending).rejects.toThrow("Failed to get notes");
    await dispatched;
    if (change === "capability") observeReadCapabilities("replacement", "test-retirement");
    else observeReadSession(change === "account" ? "replacement" : "reader", "new-session");
    finish();
    await rejected;
    expect(calls).toBe(1);
  },
);

test("retired siblings join one fresh shared flight without publishing the prior result", async () => {
  let finishOld!: () => void;
  let finishFresh!: () => void;
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  let freshStarted!: () => void;
  const freshDispatched = new Promise<void>((resolve) => {
    freshStarted = resolve;
  });
  let calls = 0;
  axios.defaults.adapter = async (config) => {
    const revision = ++calls;
    started();
    await new Promise<void>((resolve) => {
      if (revision === 1) finishOld = resolve;
      else {
        finishFresh = resolve;
        freshStarted();
      }
    });
    return reply(config, { notes: [{ preview: `revision-${revision}` }] });
  };
  const client = new MoiraApiClient();
  const first = client.getNotes();
  const sibling = client.getNotes();
  await dispatched;
  retireReads();
  finishOld();
  // Wait for the fresh transport, rather than predicting its number of microtasks.
  await freshDispatched;
  finishFresh();
  expect((await first).notes[0].preview).toBe("revision-2");
  expect(await sibling).toEqual(await first);
  expect(calls).toBe(2);
});

test("refresh retirement bypasses previous validators and inflight; the retired answer cannot win", async () => {
  let finish!: () => void;
  let dispatches = 0;
  const validators: unknown[] = [];
  axios.defaults.adapter = async (config) => {
    validators.push(config.headers.get("If-None-Match"));
    const number = ++dispatches;
    if (number === 2)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return reply(config, { notes: [{ preview: `revision-${number}` }] });
  };
  const client = new MoiraApiClient();
  await client.getNotes();
  const old = client.getNotes();
  await Promise.resolve();
  await Promise.resolve();
  retireReads();
  expect((await client.getNotes()).notes[0].preview).toBe("revision-3");
  finish();
  expect((await old).notes[0].preview).toBe("revision-4");
  expect(validators[2]).toBeUndefined();
  expect((await client.getNotes()).notes[0].preview).toBe("revision-5");
});

test.each([207, 400])(
  "mutation outcome %i retires reads even when the caller reports partial failure",
  async (status) => {
    const validators: unknown[] = [];
    axios.defaults.adapter = async (config) => {
      if (config.method === "put") {
        const response = reply(
          config,
          { saved: { one: true }, refused: [{ key: "two", reason: "denied" }] },
          "",
          status,
        );
        if (status === 400)
          throw new AxiosError("refused", "ERR_BAD_REQUEST", config, undefined, response);
        return response;
      }
      validators.push(config.headers.get("If-None-Match"));
      return reply(config, { notes: [], total: 0, allTags: [] });
    };
    const client = new MoiraApiClient();
    await client.getNotes();
    if (status === 207)
      expect((await client.updateUserSettings({ one: true })).refused).toHaveLength(1);
    else await expect(client.updateUserSettings({ one: true })).rejects.toThrow();
    await client.getNotes();
    expect(validators).toEqual([undefined, undefined]);
  },
);

test("raw effects retire on rejection and account/backend changes cannot reuse a representation", async () => {
  const validators: unknown[] = [];
  axios.defaults.adapter = async (config) => {
    validators.push(config.headers.get("If-None-Match"));
    return reply(config, { notes: [], total: 0, allTags: [] });
  };
  const client = new MoiraApiClient();
  await client.getNotes();
  await expect(
    runReadInvalidatingEffect(async () => {
      throw new Error("persisted refusal");
    }),
  ).rejects.toThrow("persisted refusal");
  await client.getNotes();
  observeReadSession("other-reader", "session-b");
  await client.getNotes();
  client.updateBaseURL("https://other-backend.example");
  await client.getNotes();
  expect(validators).toEqual([undefined, undefined, undefined, undefined]);
});

test("sensitive settings values and volatile observations always take independent fresh requests", async () => {
  let reads = 0;
  axios.defaults.adapter = async (config) => {
    reads++;
    expect(config.headers.get("If-None-Match")).toBeUndefined();
    expect(config.headers.get("Cache-Control")).toBe("no-cache");
    return reply(config, { value: reads });
  };
  const client = new MoiraApiClient();
  await Promise.all([
    client.getUserSettings(),
    client.getUserSettings(),
    client.getAdminSystemStatus(),
    client.getAdminSystemStatus(),
  ]);
  expect(reads).toBe(4);
});

test.each(["page", "rows", "changes"] as const)(
  "overview %s validates each volatile read and rejects a retired owner",
  async (kind) => {
    const requests: InternalAxiosRequestConfig[] = [];
    let release!: () => void;
    let dispatch!: () => void;
    let held = false;
    let started = Promise.resolve();
    axios.defaults.adapter = async (config) => {
      requests.push(config);
      expect(config.headers.get("If-None-Match")).toBeUndefined();
      expect(config.headers.get("Cache-Control")).toBe("no-cache");
      if (held) {
        dispatch();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return reply(
        config,
        kind === "changes"
          ? { reset: false, events: [], lastSeq: requests.length }
          : { runs: [{ title: `source-${requests.length}` }], total: 1, limit: 50, offset: 0 },
      );
    };
    const client = new MoiraApiClient();
    const read = () =>
      kind === "page"
        ? client.getOverview({ activeFrom: 0, activeTo: 0 })
        : kind === "rows"
          ? client.getOverviewRows(["run"])
          : client.getOverviewChanges(0);
    const first = await read();
    const second = await read();
    expect(second).not.toEqual(first);
    expect(requests).toHaveLength(2);
    if (kind === "page")
      expect(requests[0].params).toMatchObject({ activeFrom: "0", activeTo: "0" });
    if (kind === "changes") expect(requests[0].params).toEqual({ after: "0" });
    held = true;
    started = new Promise<void>((resolve) => {
      dispatch = resolve;
    });
    const old = read();
    const rejected = expect(old).rejects.toThrow();
    await started;
    observeReadSession("replacement", "replacement-session");
    release();
    await rejected;
    expect(requests).toHaveLength(3);
  },
);

test("bounded retention evicts oldest representations and failures never acquire a validator", async () => {
  const store = new ConditionalReadStore<string>(2);
  const read = (key: string) =>
    store.read(key, async (etag) => ({ value: etag ? "cached" : "network", etag: key }), true);
  await read("a");
  await read("b");
  await read("c");
  expect(await read("a")).toBe("network");
  await expect(
    store.read(
      "failed",
      async () => {
        throw new Error("offline");
      },
      true,
    ),
  ).rejects.toThrow("offline");
  expect(
    await store.read("failed", async (etag) => ({ value: etag ?? "fresh", etag: "ok" }), true),
  ).toBe("fresh");
});

test("retained validators expire after five minutes since their last successful source check", async () => {
  let now = 1000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  const store = new ConditionalReadStore<string>();
  const validators: Array<string | undefined> = [];
  const read = () =>
    store.read(
      "same-query",
      async (etag) => {
        validators.push(etag);
        return { value: "current source", etag: "current", unchanged: !!etag };
      },
      true,
    );

  expect(await read()).toBe("current source");
  now += 5 * 60_000 - 1;
  expect(await read()).toBe("current source");
  now += 5 * 60_000;
  expect(await read()).toBe("current source");
  expect(validators).toEqual([undefined, "current", undefined]);
});

test("oversized successful bodies remain readable without becoming retained representations", async () => {
  const store = new ConditionalReadStore<string>(2, 5 * 60_000, 64);
  const large = "x".repeat(1000);
  const validators: Array<string | undefined> = [];
  const read = (key: string, value: string) =>
    store.read(
      key,
      async (etag) => {
        validators.push(etag);
        return { value, etag: key };
      },
      true,
    );

  expect(await read("small", "small body")).toBe("small body");
  expect(await read("small", "small body")).toBe("small body");
  expect(await read("large", large)).toBe(large);
  expect(await read("large", large)).toBe(large);
  expect(validators).toEqual([undefined, "small", undefined, undefined]);
});

test("pending flight registration stops at its capacity while excess reads still finish", async () => {
  const store = new ConditionalReadStore<string>(2);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const dispatched: string[] = [];
  const read = (key: string) =>
    store.read(
      key,
      async () => {
        dispatched.push(key);
        await pending;
        return { value: key, etag: key };
      },
      true,
    );

  const reads = [read("a"), read("a"), read("b"), read("b"), read("c"), read("c")];
  finish();
  expect(await Promise.all(reads)).toEqual(["a", "a", "b", "b", "c", "c"]);
  expect(dispatched).toEqual(["a", "b", "c", "c"]);
});

test("an unmatched304 is an error and cannot create a successful retained answer", async () => {
  const store = new ConditionalReadStore<string>();
  await expect(
    store.read(
      "missing",
      async () => ({
        value: "unavailable body",
        etag: "missing",
        unchanged: true,
      }),
      true,
    ),
  ).rejects.toThrow(/304/);

  let validator: string | undefined;
  expect(
    await store.read(
      "missing",
      async (etag) => {
        validator = etag;
        return { value: "fresh source", etag: "fresh" };
      },
      true,
    ),
  ).toBe("fresh source");
  expect(validator).toBeUndefined();
});

test("user choices preserve canonical scope and server order through 304, while management remains rich and fresh", async () => {
  let role = false;
  const calls: Array<{ url: string; validator: unknown }> = [];
  axios.defaults.adapter = async (config) => {
    const url = new URL(config.url!, "https://example.test");
    const lookup = url.searchParams.get("projection") === "lookup";
    const etag = `W/"role-${role}"`;
    const validator = config.headers.get("If-None-Match");
    calls.push({ url: config.url!, validator });
    return reply(
      config,
      {
        users: [
          {
            id: "z",
            name: "A",
            email: "z@example.test",
            isAdmin: role,
            ...(!lookup ? { workflowsCount: 42 } : {}),
          },
          { id: "a", name: "Z", email: "a@example.test", isAdmin: false },
        ],
        total: 2,
        limit: 100,
        offset: 0,
      },
      etag,
      lookup && validator === etag ? 304 : 200,
    );
  };
  const client = new MoiraApiClient();
  await client.getAdminUserChoices({ ids: ["z", "a", "a"], sort: "name", limit: 100 });
  const warm = await client.getAdminUserChoices({ ids: ["a", "z"], sort: "name", limit: 100 });
  expect(warm.users.map((user) => user.id)).toEqual(["z", "a"]);
  const query = new URL(calls[0].url, "https://example.test").searchParams;
  expect(query.get("ids")).toBe("a,z");
  expect(query.get("sort")).toBe("name");
  expect(calls[1].validator).toBe('W/"role-false"');
  role = true;
  expect(
    (await client.getAdminUserChoices({ ids: ["z", "a"], sort: "name", limit: 100 })).users[0]
      .isAdmin,
  ).toBe(true);
  expect((await client.getAdminUsers({ limit: 100 })).users[0].workflowsCount).toBe(42);
  await client.getAdminUsers({ limit: 100 });
  expect(calls.slice(-2).map((call) => call.validator)).toEqual([undefined, undefined]);
});
