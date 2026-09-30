/**
 * The overview's live stream (`GET /api/executions/overview/stream`) and its poll fallback, against
 * the real container — through its nginx, so an event that arrives while the connection stays open
 * also shows the stream is not buffered. Fresh users own every run here. The container re-checks a
 * stream's session every `OVERVIEW_STREAM_RECHECK_MS` (2 s in the test environments).
 */

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { getTestBaseUrl, getTestRequestOrigin } from "../utils/test-config.js";
import {
  blockUserViaApi,
  callMCPTool,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
  formatSessionCookie,
  signInUser,
  startWorkflowExecutionState,
  unblockUserViaApi,
} from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "Overview-Stream-Password-1";
/** Recheck interval of the test environment plus the watcher's second and some slack. */
const CLOSE_WITHIN_MS = 10_000;

interface StreamEvent {
  id: number | null;
  event: string;
  data: Record<string, unknown>;
}

/** An open event stream, read frame by frame. */
class EventStream {
  private buffer = "";
  private readonly events: StreamEvent[] = [];
  private ended = false;
  private readonly waiters: Array<() => void> = [];

  private constructor(
    readonly status: number,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array> | null,
    private readonly abort: AbortController,
  ) {
    if (reader) void this.pump();
  }

  static async open(cookie: string, lastEventId?: number): Promise<EventStream> {
    const abort = new AbortController();
    const response = await fetch(`${BASE_URL}/api/executions/overview/stream`, {
      headers: {
        Cookie: formatSessionCookie(BASE_URL, cookie),
        Accept: "text/event-stream",
        ...(lastEventId !== undefined ? { "Last-Event-ID": String(lastEventId) } : {}),
      },
      signal: abort.signal,
    });
    const reader = response.status === 200 && response.body ? response.body.getReader() : null;
    return new EventStream(response.status, reader, abort);
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await this.reader!.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = this.buffer.indexOf("\n\n")) >= 0) {
          const frame = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 2);
          const lines = frame.split("\n").filter((line) => !line.startsWith(":"));
          if (lines.length === 0) continue;
          const field = (name: string) =>
            lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
          const id = field("id");
          this.events.push({
            id: id === undefined ? null : Number(id),
            event: field("event") ?? "message",
            data: JSON.parse(field("data") ?? "{}") as Record<string, unknown>,
          });
          this.waiters.splice(0).forEach((wake) => wake());
        }
      }
    } catch {
      // aborted
    }
    this.ended = true;
    this.waiters.splice(0).forEach((wake) => wake());
  }

  /** Wait until `predicate` holds over the events read so far, or fail after `timeoutMs`. */
  async until(predicate: (events: StreamEvent[]) => boolean, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.events)) {
      if (Date.now() > deadline) {
        throw new Error(`Stream condition not met; events: ${JSON.stringify(this.events)}`);
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 200);
      });
    }
    return this.events;
  }

  /** Resolves once the server has closed the stream, or fails after `timeoutMs`. */
  async closedWithin(timeoutMs: number): Promise<void> {
    await this.until(() => this.ended, timeoutMs);
  }

  get all(): StreamEvent[] {
    return this.events;
  }

  get lastId(): number {
    return [...this.events].reverse().find((event) => event.id !== null)?.id ?? 0;
  }

  close(): void {
    this.abort.abort();
  }
}

function plainFlow(name: string) {
  return {
    metadata: { name, version: "1.0.0", description: "One step of work" },
    nodes: [
      { type: "start", id: "start", connections: { default: "task" } },
      {
        type: "agent-directive",
        id: "task",
        directive: "Import the orders",
        completionCondition: "Imported",
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

async function newUser(label: string) {
  const email = `stream-${label}-${Date.now()}@example.test`;
  const { userId } = await createTestUserViaApi(BASE_URL, email, PASSWORD, `Stream ${label}`);
  return { email, userId, cookie: await signInUser(BASE_URL, email, PASSWORD) };
}

describe("GET /api/executions/overview/stream", () => {
  const streams: EventStream[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  let owner: Awaited<ReturnType<typeof newUser>>;
  let other: Awaited<ReturnType<typeof newUser>>;
  let client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"];
  let workflowId: string;

  async function open(cookie: string, lastEventId?: number) {
    const stream = await EventStream.open(cookie, lastEventId);
    streams.push(stream);
    return stream;
  }

  async function startRun(note: string): Promise<string> {
    const run = await startWorkflowExecutionState(client, workflowId, {
      note,
      skipNotificationCheck: true,
    });
    return run.processId;
  }

  async function setNote(executionId: string, note: string): Promise<void> {
    await callMCPTool(client, "session", { action: "update-note", executionId, note });
  }

  beforeAll(async () => {
    owner = await newUser("owner");
    other = await newUser("other");
    const mcp = await createAuthenticatedMCPClient({ email: owner.email, password: PASSWORD });
    client = mcp.client;
    cleanups.push(mcp.cleanup);
    const created = await callMCPTool<{ workflowId: string }>(client, "manage", {
      action: "create",
      workflow: plainFlow(`Order import stream ${Date.now()}`),
    });
    workflowId = created.workflowId;
  });

  afterAll(async () => {
    for (const stream of streams) stream.close();
    for (const cleanup of cleanups) await cleanup();
  });

  test("a new stream announces where it starts, then delivers the owner's changes in order", async () => {
    const stream = await open(owner.cookie);
    expect(stream.status).toBe(200);
    await stream.until((events) => events.some((event) => event.event === "ready"));

    const executionId = await startRun("Import March orders");
    await setNote(executionId, "Import March orders again");
    const events = await stream.until(
      (all) =>
        all.filter((event) => event.event === "change" && event.data.executionId === executionId)
          .length >= 2,
    );
    const mine = events.filter(
      (event) => event.event === "change" && event.data.executionId === executionId,
    );
    expect(mine[0].data.kind).toBe("created");
    expect(mine.map((event) => event.data.kind)).toContain("meta");
    const ids = events.map((event) => event.id).filter((id): id is number => id !== null);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    stream.close();
  });

  test("a stream resumed with Last-Event-ID receives exactly the changes it missed", async () => {
    const first = await open(owner.cookie);
    await first.until((events) => events.some((event) => event.event === "ready"));
    const executionId = await startRun("Import April orders");
    await first.until((events) =>
      events.some((event) => event.event === "change" && event.data.executionId === executionId),
    );
    const resumeFrom = first.lastId;
    first.close();

    await setNote(executionId, "Import April orders, second batch");
    await setNote(executionId, "Import April orders, third batch");

    const resumed = await open(owner.cookie, resumeFrom);
    const events = await resumed.until(
      (all) => all.filter((event) => event.event === "change").length >= 2,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const changes = resumed.all.filter((event) => event.event === "change");
    expect(changes.map((event) => [event.data.executionId, event.data.kind])).toEqual([
      [executionId, "meta"],
      [executionId, "meta"],
    ]);
    expect(events.every((event) => event.id === null || event.id > resumeFrom)).toBe(true);
    resumed.close();
  });

  test("another person's stream receives none of these changes", async () => {
    const foreign = await open(other.cookie);
    await foreign.until((events) => events.some((event) => event.event === "ready"));
    const executionId = await startRun("Import May orders");
    await setNote(executionId, "Import May orders again");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(foreign.all.filter((event) => event.event === "change")).toEqual([]);
    foreign.close();
  });

  test("the poll fallback returns the owner's changes after a cursor", async () => {
    const stream = await open(owner.cookie);
    await stream.until((events) => events.some((event) => event.event === "ready"));
    const cursor = stream.lastId;
    stream.close();
    const executionId = await startRun("Import June orders");
    const response = await fetch(`${BASE_URL}/api/executions/overview/changes?after=${cursor}`, {
      headers: { Cookie: formatSessionCookie(BASE_URL, owner.cookie) },
    });
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as {
      data: {
        reset: boolean;
        events: Array<{ executionId: string; kind: string }>;
        lastSeq: number;
      };
    };
    expect(data.reset).toBe(false);
    expect(data.events).toContainEqual(expect.objectContaining({ executionId, kind: "created" }));
    expect(data.lastSeq).toBeGreaterThan(cursor);
  });

  test("beyond the per-user limit a new stream is refused", async () => {
    const opened = [];
    for (let index = 0; index < 5; index += 1) opened.push(await open(owner.cookie));
    expect(opened.map((stream) => stream.status)).toEqual([200, 200, 200, 200, 200]);
    await Promise.all(
      opened.map((stream) =>
        stream.until((events) => events.some((event) => event.event === "ready")),
      ),
    );
    const refused = await open(owner.cookie);
    expect(refused.status).toBe(429);
    for (const stream of opened) stream.close();
    // Closed streams free their places.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const again = await open(owner.cookie);
    expect(again.status).toBe(200);
    again.close();
  });

  test("an open stream is closed after its session is signed out", async () => {
    const signedIn = await newUser("signout");
    const stream = await open(signedIn.cookie);
    await stream.until((events) => events.some((event) => event.event === "ready"));
    const signout = await fetch(`${BASE_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        Cookie: formatSessionCookie(BASE_URL, signedIn.cookie),
        Origin: getTestRequestOrigin(),
      },
    });
    expect(signout.status).toBe(200);
    await stream.closedWithin(CLOSE_WITHIN_MS);
  });

  test("an open stream is closed after its user is blocked", async () => {
    const blocked = await newUser("blocked");
    const stream = await open(blocked.cookie);
    await stream.until((events) => events.some((event) => event.event === "ready"));
    await blockUserViaApi(BASE_URL, blocked.userId, "Stream test");
    try {
      await stream.closedWithin(CLOSE_WITHIN_MS);
    } finally {
      await unblockUserViaApi(BASE_URL, blocked.userId);
    }
  });
});
