import { afterEach, describe, expect, test } from "@jest/globals";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import type { ExecutionChangeEvent, ExecutionChangeRepository } from "@mcp-moira/shared";
import {
  CATCH_UP_LIMIT,
  changesAfter,
  ExecutionChangeHub,
  openExecutionChangeStream,
} from "../../../packages/web-backend/src/services/execution-change-stream.js";

/**
 * Failures of the feed reach neither the process nor the per-user stream count: the watcher keeps
 * running after a failed read, and a stream whose catch-up read fails is ended and releases its place.
 * No event is skipped silently: a catch-up longer than one read is answered with `reset`, and a poll
 * never moves its cursor past an event it did not return.
 */

const USER_ID = "stream-unit-user";

function event(seq: number): ExecutionChangeEvent {
  return { seq, executionId: `run-${seq}`, userId: USER_ID, kind: "activity", at: seq };
}

/** A feed over an in-memory list whose reads can be made to fail. */
class FakeFeed {
  readonly events: ExecutionChangeEvent[] = [];
  failures = 0;
  /** Called on every per-user read, before it returns — a commit landing mid-read. */
  duringRead: () => void = () => undefined;

  private read<T>(result: () => T): T {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("SQLITE_BUSY: database is locked");
    }
    return result();
  }

  since(seq: number, limit: number) {
    return this.read(() => this.events.filter((e) => e.seq > seq).slice(0, limit));
  }
  forUserAfter(userId: string, seq: number, limit: number, through = Number.MAX_SAFE_INTEGER) {
    return this.read(() => {
      const found = this.events
        .filter((e) => e.userId === userId && e.seq > seq && e.seq <= through)
        .slice(0, limit);
      this.duringRead();
      return found;
    });
  }
  latestSeq() {
    return this.events.at(-1)?.seq ?? 0;
  }
  isExpired() {
    return this.read(() => false);
  }
  deleteOlderThan() {
    return this.read(() => 0);
  }
}

function asRepository(feed: FakeFeed): ExecutionChangeRepository {
  return feed as unknown as ExecutionChangeRepository;
}

const hubs: ExecutionChangeHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.stop();
});

describe("the watcher of the change feed", () => {
  test("a failed read of the feed is retried on the next tick and delivers the event", async () => {
    const feed = new FakeFeed();
    const hub = new ExecutionChangeHub(asRepository(feed), 10);
    hubs.push(hub);
    const delivered: number[] = [];
    hub.subscribe(USER_ID, (change) => delivered.push(change.seq));
    hub.start();

    feed.failures = 2;
    feed.events.push(event(1));
    const deadline = Date.now() + 2_000;
    while (delivered.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(feed.failures).toBe(0);
    expect(delivered).toEqual([1]);
  });
});

function fakeRequest(lastEventId: string): Request {
  const request = new EventEmitter() as EventEmitter & Partial<Request>;
  request.header = ((name: string) =>
    name.toLowerCase() === "last-event-id" ? lastEventId : undefined) as Request["header"];
  request.query = {};
  return request as Request;
}

function fakeResponse() {
  const response = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const state = { ended: false, written: [] as string[] };
  response.status = () => response;
  response.setHeader = () => response;
  response.flushHeaders = () => undefined;
  response.json = () => response;
  response.write = (chunk: string) => {
    state.written.push(chunk);
    return true;
  };
  response.end = () => {
    state.ended = true;
    response.emit("close");
    return response;
  };
  return { response: response as unknown as Response, state };
}

describe("a stream whose catch-up read fails", () => {
  test("is ended and no longer counts against the user's streams", () => {
    const feed = new FakeFeed();
    feed.events.push(event(1));
    const hub = new ExecutionChangeHub(asRepository(feed), 60_000);
    hubs.push(hub);
    const { response, state } = fakeResponse();

    feed.failures = 1;
    openExecutionChangeStream(fakeRequest("0"), response, USER_ID, {
      hub,
      feed: asRepository(feed),
      sessionStillValid: async () => true,
      recheckMs: 60_000,
    });

    expect(state.ended).toBe(true);
    expect(hub.openStreams(USER_ID)).toBe(0);
  });
});

describe("nothing is skipped silently", () => {
  test("a stream missing more events than one catch-up holds is told to reset", () => {
    const feed = new FakeFeed();
    for (let seq = 1; seq <= CATCH_UP_LIMIT + 5; seq += 1) feed.events.push(event(seq));
    const hub = new ExecutionChangeHub(asRepository(feed), 60_000);
    hubs.push(hub);
    const { response, state } = fakeResponse();

    openExecutionChangeStream(fakeRequest("0"), response, USER_ID, {
      hub,
      feed: asRepository(feed),
      sessionStillValid: async () => true,
      recheckMs: 60_000,
    });
    response.emit("close");

    expect(state.written.some((chunk) => chunk.includes("event: reset"))).toBe(true);
    expect(state.written.some((chunk) => chunk.includes("event: change"))).toBe(false);
  });

  test("an event committed while a poll reads is returned by the next poll", () => {
    const feed = new FakeFeed();
    feed.events.push(event(1));
    feed.duringRead = () => {
      feed.duringRead = () => undefined;
      feed.events.push(event(2));
    };
    const repository = asRepository(feed);

    const first = changesAfter(repository, USER_ID, 0);
    if (first.reset) throw new Error("unexpected reset");
    const second = changesAfter(repository, USER_ID, first.lastSeq);
    if (second.reset) throw new Error("unexpected reset");

    expect([...first.events, ...second.events].map((change) => change.seq)).toEqual([1, 2]);
  });
});
