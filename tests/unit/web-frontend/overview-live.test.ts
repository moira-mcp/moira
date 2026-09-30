/**
 * The overview's live connection across tabs, driven with controlled Web Locks, a shared broadcast
 * channel, streams the test opens and fails, and a manual clock: one stream for all tabs with the
 * others fed by the channel; the lock passing on with the cursor; polling every 15 s after three
 * failures to open the stream; the stream closed while every tab is hidden and caught up after.
 * Plus how a change is turned into a page update.
 */

import { describe, expect, test } from "@jest/globals";
import type {
  OverviewChange,
  OverviewChanges,
} from "../../../packages/web-frontend/src/services/api-client.js";
import {
  FAILURES_BEFORE_POLLING,
  LiveConnection,
  POLL_INTERVAL_MS,
  READY_TIMEOUT_MS,
  RECONNECT_DELAY_MS,
  STREAM_RETRY_AFTER_MS,
  type ChannelLike,
  type LiveDependencies,
  type LiveMessage,
  type LiveSnapshot,
  type LocksLike,
  type StreamLike,
} from "../../../packages/web-frontend/src/components/overview/liveConnection.js";
import { routeLiveMessage } from "../../../packages/web-frontend/src/components/overview/useLiveOverview.js";

/** A clock whose timers fire only when the test moves it on. */
class Clock {
  now = 0;
  private timers: Array<{ id: number; at: number; callback: () => void }> = [];
  private next = 1;
  set(callback: () => void, ms: number): number {
    const id = this.next++;
    this.timers.push({ id, at: this.now + ms, callback });
    return id;
  }
  clear(id: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.now = due.at;
      due.callback();
      await settle();
    }
    this.now = until;
  }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await Promise.resolve();
}

/** A broadcast channel shared by the tabs: a message reaches every other tab at once. */
class Bus {
  private readonly members = new Set<FakeChannel>();
  join(): FakeChannel {
    const channel = new FakeChannel(this);
    this.members.add(channel);
    return channel;
  }
  leave(channel: FakeChannel): void {
    this.members.delete(channel);
  }
  send(from: FakeChannel, message: unknown): void {
    for (const member of [...this.members]) {
      if (member !== from) member.onmessage?.({ data: structuredClone(message) } as MessageEvent);
    }
  }
}

class FakeChannel implements ChannelLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(private readonly bus: Bus) {}
  postMessage(message: unknown): void {
    this.bus.send(this, message);
  }
  close(): void {
    this.bus.leave(this);
  }
}

/** Web Locks with one holder at a time and a queue behind it. */
class FakeLocks implements LocksLike {
  private held = false;
  private readonly queue: Array<() => Promise<void>> = [];
  request(_name: string, callback: () => Promise<void>): Promise<void> {
    this.queue.push(callback);
    this.grant();
    return Promise.resolve();
  }
  private grant(): void {
    if (this.held) return;
    const next = this.queue.shift();
    if (!next) return;
    this.held = true;
    void next().then(() => {
      this.held = false;
      this.grant();
    });
  }
}

class FakeStream implements StreamLike {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, (event: MessageEvent) => void>();
  constructor(readonly after: number | null) {}
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, id: number, data: unknown = {}): void {
    this.onopen?.({} as Event);
    this.listeners.get(type)?.({
      lastEventId: String(id),
      data: JSON.stringify(data),
    } as MessageEvent);
  }
  fail(): void {
    this.onerror?.({} as Event);
  }
  /** The response's headers arrived; nothing else did. */
  openOnly(): void {
    this.onopen?.({} as Event);
  }
}

interface Tab {
  connection: LiveConnection;
  messages: LiveMessage[];
  snapshots: LiveSnapshot[];
  visible: boolean;
  setVisible(visible: boolean): void;
  get state(): string;
}

function world(
  poll: (after: number | null) => Promise<OverviewChanges> = async () => ({
    reset: false,
    events: [],
    lastSeq: 0,
  }),
) {
  const clock = new Clock();
  const bus = new Bus();
  const locks = new FakeLocks();
  const streams: FakeStream[] = [];
  const polls: Array<number | null> = [];
  let tabs = 0;
  function open(): Tab {
    const listeners = new Set<() => void>();
    const tab: Tab = {
      messages: [],
      snapshots: [],
      visible: true,
      setVisible(visible) {
        tab.visible = visible;
        listeners.forEach((listener) => listener());
      },
      get state() {
        return tab.snapshots.at(-1)?.state ?? "connecting";
      },
      connection: undefined as unknown as LiveConnection,
    };
    const deps: LiveDependencies = {
      openStream: (after) => {
        const stream = new FakeStream(after);
        streams.push(stream);
        return stream;
      },
      pollChanges: (after) => {
        polls.push(after);
        return poll(after);
      },
      locks,
      channel: bus.join(),
      isVisible: () => tab.visible,
      onVisibilityChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setTimer: (callback, ms) => clock.set(callback, ms),
      clearTimer: (handle) => clock.clear(handle),
      now: () => clock.now,
      tabId: `tab-${++tabs}`,
    };
    tab.connection = new LiveConnection(
      deps,
      (message) => tab.messages.push(message),
      (snapshot) => tab.snapshots.push(snapshot),
    );
    tab.connection.start();
    return tab;
  }
  const openStreams = () => streams.filter((stream) => !stream.closed);
  return { clock, open, streams, openStreams, polls };
}

const change = (seq: number, executionId = "run-1"): OverviewChange => ({
  seq,
  executionId,
  kind: "activity",
});

describe("the live connection across tabs", () => {
  test("of two tabs only the leader opens the stream; a change reaches both", async () => {
    const { open, openStreams } = world();
    const first = open();
    const second = open();
    await settle();
    expect(first.connection.isLeader).toBe(true);
    expect(second.connection.isLeader).toBe(false);
    expect(openStreams()).toHaveLength(1);

    const [stream] = openStreams();
    stream.emit("ready", 7);
    stream.emit("change", 8, { executionId: "run-1", kind: "activity" });
    expect(first.messages).toEqual([{ type: "change", change: change(8) }]);
    expect(second.messages).toEqual([{ type: "change", change: change(8) }]);
    // The second tab says what the leader's connection is.
    expect(second.state).toBe("live");
  });

  test("when the leader leaves, the next tab leads and resumes after the last change it saw", async () => {
    const { open, openStreams } = world();
    const first = open();
    const second = open();
    await settle();
    openStreams()[0].emit("change", 12, { executionId: "run-1", kind: "meta" });

    first.connection.stop();
    await settle();
    expect(second.connection.isLeader).toBe(true);
    const resumed = openStreams();
    expect(resumed).toHaveLength(1);
    expect(resumed[0].after).toBe(12);
  });

  test("after three failures to open the stream, the leader polls every 15 s and later tries the stream again", async () => {
    const polled: OverviewChanges[] = [
      { reset: false, events: [], lastSeq: 30 },
      { reset: false, events: [change(31)], lastSeq: 31 },
    ];
    const { clock, open, streams, polls } = world(
      async () => polled.shift() ?? { reset: false, events: [], lastSeq: 31 },
    );
    const tab = open();
    await settle();
    for (let attempt = 1; attempt <= FAILURES_BEFORE_POLLING; attempt += 1) {
      streams.at(-1)!.fail();
      // Between failures the stream is reopened after a pause; after the last one it is not.
      await clock.advance(attempt < FAILURES_BEFORE_POLLING ? 10_000 : 0);
    }
    expect(streams).toHaveLength(FAILURES_BEFORE_POLLING);
    expect(tab.state).toBe("polling");
    // The first poll, without a cursor, only learns where the feed stands; the next comes 15 s later.
    expect(polls).toEqual([null]);
    await clock.advance(POLL_INTERVAL_MS - 1);
    expect(polls).toEqual([null]);
    await clock.advance(1);
    expect(polls).toEqual([null, 30]);
    expect(tab.messages).toEqual([{ type: "change", change: change(31) }]);

    await clock.advance(STREAM_RETRY_AFTER_MS);
    // The stream is tried again, from the last change polling brought.
    expect(streams[FAILURES_BEFORE_POLLING].after).toBe(31);
  });

  test("with every tab hidden the stream closes, and it reopens after the last change once a tab is shown", async () => {
    const { open, openStreams, streams } = world();
    const first = open();
    const second = open();
    await settle();
    openStreams()[0].emit("change", 5, { executionId: "run-1", kind: "activity" });

    first.setVisible(false);
    expect(openStreams()).toHaveLength(1);
    second.setVisible(false);
    expect(openStreams()).toHaveLength(0);

    second.setVisible(true);
    expect(openStreams()).toHaveLength(1);
    expect(streams.at(-1)!.after).toBe(5);
  });
});

describe("the live connection behind proxies and between tabs", () => {
  test("a stream whose headers pass but which never confirms counts as failed; three such mean polling", async () => {
    const { clock, open, streams, polls } = world();
    const tab = open();
    await settle();
    for (let attempt = 1; attempt <= FAILURES_BEFORE_POLLING; attempt += 1) {
      streams.at(-1)!.openOnly();
      await clock.advance(READY_TIMEOUT_MS);
      // The pause before reopening grows with each failure.
      if (attempt < FAILURES_BEFORE_POLLING) await clock.advance(RECONNECT_DELAY_MS * attempt);
    }
    expect(tab.state).toBe("polling");
    expect(polls).toEqual([null]);
  });

  test("hiding and showing the page while a poll is on its way keeps one poll loop", async () => {
    let answer: ((changes: OverviewChanges) => void) | null = null;
    const pending: Array<(changes: OverviewChanges) => void> = [];
    const { clock, open, streams, polls } = world(
      () =>
        new Promise<OverviewChanges>((resolve) => {
          pending.push(resolve);
        }),
    );
    const tab = open();
    await settle();
    for (let attempt = 1; attempt <= FAILURES_BEFORE_POLLING; attempt += 1) {
      streams.at(-1)!.fail();
      await clock.advance(attempt < FAILURES_BEFORE_POLLING ? 10_000 : 0);
    }
    expect(polls).toHaveLength(1);
    // The first poll is on its way when the page is hidden and shown again.
    tab.setVisible(false);
    tab.setVisible(true);
    await clock.advance(0);
    for (answer of pending.splice(0)) answer({ reset: false, events: [], lastSeq: 5 });
    await settle();
    const before = polls.length;
    await clock.advance(POLL_INTERVAL_MS);
    for (answer of pending.splice(0)) answer({ reset: false, events: [], lastSeq: 5 });
    await settle();
    expect(polls.length - before).toBe(1);
  });

  test("the position the stream starts from reaches the other tabs, so the next leader resumes from it", async () => {
    const { open, openStreams } = world();
    const first = open();
    const second = open();
    await settle();
    openStreams()[0].emit("ready", 20);
    first.connection.stop();
    await settle();
    expect(second.connection.isLeader).toBe(true);
    expect(openStreams()[0].after).toBe(20);
  });
});

describe("a change turned into a page update", () => {
  const removed: string[] = [];
  const handlers = {
    removeRun: (id: string) => removed.push(id),
  };

  test.each([
    [
      "activity of a child can reorder its tree and refetches the page",
      "activity",
      "child",
      [],
      true,
    ],
    [
      "metadata can change search membership or nesting and refetches the page",
      "meta",
      "root",
      [],
      true,
    ],
    ["a lock can change the status, so it refetches the page", "lock", "root", [], true],
    [
      "activity of a run outside the page can move it into the page",
      "activity",
      "elsewhere",
      [],
      true,
    ],
    ["a new run refetches the page", "created", "elsewhere", [], true],
    ["a change of status refetches the page", "status", "child", [], true],
  ] as const)("%s", (_name, kind, executionId, rows, refetch) => {
    expect(
      routeLiveMessage({ type: "change", change: { seq: 1, executionId, kind } }, handlers),
    ).toEqual({ rows, refetch });
  });

  test("a deleted run leaves the page at once and the page is refetched; so does a reset", () => {
    expect(
      routeLiveMessage(
        { type: "change", change: { seq: 2, executionId: "child", kind: "deleted" } },
        handlers,
      ),
    ).toEqual({ rows: [], refetch: true });
    expect(removed).toEqual(["child"]);
    expect(routeLiveMessage({ type: "reset" }, handlers)).toEqual({ rows: [], refetch: true });
  });
});
