/**
 * Live updates of the overview: the change feed of execution rows delivered as Server-Sent Events.
 *
 * Processes share no memory, so the web backend learns about changes by reading the feed. One
 * watcher per process (`ExecutionChangeHub`) reads the events after the last one it saw every second
 * and hands each only to its owner's open streams — even bare ids would tell another person that a
 * run moved. A stream (`openExecutionChangeStream`) catches up from the client's cursor
 * (`Last-Event-ID` or `after`), answers an expired cursor with `reset`, sends a heartbeat comment
 * every 25 seconds, re-checks the session on an interval and closes when the session is gone or the
 * user blocked, and refuses a stream beyond the per-user limit. Events carry the run id and the kind
 * of change only; the client refetches the rows through the owner-scoped overview.
 */

import type { Request, Response } from "express";
import {
  EXECUTION_CHANGE_RETENTION_MS,
  ExecutionChangeRepository,
  getOverviewStreamRecheckMs,
  getSqliteInstance,
  type ExecutionChangeEvent,
} from "@mcp-moira/shared";
import { logger } from "../utils/logger.js";

/** How often the watcher reads the feed. */
export const CHANGE_WATCH_INTERVAL_MS = 1_000;
/** How often an open stream sends a comment so proxies keep it open. */
export const STREAM_HEARTBEAT_MS = 25_000;
/** Open streams one user may hold at once (one per browser tab-leader, with room to spare). */
export const STREAM_LIMIT_PER_USER = 5;
/** How often the feed is trimmed to its fixed retention. */
export const CHANGE_TRIM_INTERVAL_MS = 60 * 60 * 1000;
/** How often an open stream re-checks its session (`OVERVIEW_STREAM_RECHECK_MS`, default 2 min). */
export function streamRecheckMs(): number {
  return getOverviewStreamRecheckMs();
}
/** The most events one read hands out; a longer backlog is read over several ticks. */
const WATCH_BATCH = 500;
/** The most events a reconnecting stream or a poll catches up in one response. */
export const CATCH_UP_LIMIT = 1_000;

type Listener = (event: ExecutionChangeEvent) => void;

export class ExecutionChangeHub {
  private lastSeq = 0;
  private timer: NodeJS.Timeout | null = null;
  private trimTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly feed: ExecutionChangeRepository,
    private readonly intervalMs: number = CHANGE_WATCH_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.lastSeq = this.feed.latestSeq();
    // A failed read (a busy or failing database) is logged; the next tick reads again from the same
    // position, so nothing is lost and the process keeps serving.
    const guarded = (what: string, run: () => unknown) => () => {
      try {
        run();
      } catch (error) {
        logger.error(`Execution change feed ${what} failed`, error);
      }
    };
    this.timer = setInterval(
      guarded("read", () => this.tick()),
      this.intervalMs,
    );
    this.timer.unref?.();
    guarded("trim", () => this.trim())();
    this.trimTimer = setInterval(
      guarded("trim", () => this.trim()),
      CHANGE_TRIM_INTERVAL_MS,
    );
    this.trimTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.trimTimer) clearInterval(this.trimTimer);
    this.timer = null;
    this.trimTimer = null;
  }

  /** Keep the feed to its fixed retention; older cursors are answered with `reset`. */
  trim(now: number = Date.now()): number {
    return this.feed.deleteOlderThan(now - EXECUTION_CHANGE_RETENTION_MS);
  }

  /** Read what was written since the last read and hand each event to its owner's streams. */
  tick(): void {
    for (;;) {
      const events = this.feed.since(this.lastSeq, WATCH_BATCH);
      for (const event of events) {
        this.lastSeq = event.seq;
        for (const listener of this.listeners.get(event.userId) ?? []) listener(event);
      }
      if (events.length < WATCH_BATCH) return;
    }
  }

  /** The number of the latest event this watcher has handed out. */
  get seq(): number {
    return this.lastSeq;
  }

  subscribe(userId: string, listener: Listener): () => void {
    const set = this.listeners.get(userId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(userId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(userId);
    };
  }

  /** Open streams of this user. */
  openStreams(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }
}

export interface StreamOptions {
  hub: ExecutionChangeHub;
  feed: ExecutionChangeRepository;
  /** Whether the session the stream was opened with still admits it. */
  sessionStillValid: (req: Request) => Promise<boolean>;
  recheckMs: number;
  heartbeatMs?: number;
  limitPerUser?: number;
}

/** The client's cursor: `Last-Event-ID`, else `after`; undefined when it sent none. */
export function changeCursor(req: Request): number | undefined {
  const raw = req.header("last-event-id") ?? (req.query.after as string | undefined);
  if (raw === undefined || raw === "") return undefined;
  const cursor = Number(raw);
  return Number.isInteger(cursor) && cursor >= 0 ? cursor : undefined;
}

function frame(event: ExecutionChangeEvent): string {
  return `id: ${event.seq}\nevent: change\ndata: ${JSON.stringify({
    executionId: event.executionId,
    kind: event.kind,
  })}\n\n`;
}

/** Serve one stream of the signed-in user's changes until the client leaves or the session ends. */
export function openExecutionChangeStream(
  req: Request,
  res: Response,
  userId: string,
  options: StreamOptions,
): void {
  const limit = options.limitPerUser ?? STREAM_LIMIT_PER_USER;
  if (options.hub.openStreams(userId) >= limit) {
    res.status(429).json({
      success: false,
      error: { message: `At most ${limit} live streams per user`, code: "TOO_MANY_STREAMS" },
    });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // For a proxy that would otherwise buffer the response (nginx honours it).
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let lastSent = 0;
  let closed = false;
  const timers: NodeJS.Timeout[] = [];
  const queued: ExecutionChangeEvent[] = [];
  let catchingUp = true;
  const send = (event: ExecutionChangeEvent) => {
    if (closed || event.seq <= lastSent) return;
    lastSent = event.seq;
    res.write(frame(event));
  };
  const unsubscribe = options.hub.subscribe(userId, (event) => {
    if (catchingUp) queued.push(event);
    else send(event);
  });
  const close = () => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearInterval(timer);
    unsubscribe();
  };
  req.on("close", close);
  res.on("close", close);

  try {
    const cursor = changeCursor(req);
    if (cursor !== undefined && options.feed.isExpired(cursor)) {
      // What happened since the cursor is no longer kept: the client reloads the page.
      lastSent = options.hub.seq;
      res.write(`id: ${lastSent}\nevent: reset\ndata: {}\n\n`);
    } else if (cursor !== undefined) {
      const missed = options.feed.forUserAfter(userId, cursor, CATCH_UP_LIMIT);
      if (missed.length === CATCH_UP_LIMIT) {
        // More was missed than one catch-up holds: reloading is cheaper than replaying it.
        lastSent = options.hub.seq;
        res.write(`id: ${lastSent}\nevent: reset\ndata: {}\n\n`);
      } else {
        lastSent = cursor;
        for (const event of missed) send(event);
        // Caught up: say so, with the position to resume from, as a new stream does.
        res.write(`id: ${lastSent}\nevent: ready\ndata: {}\n\n`);
      }
    } else {
      // A new stream starts from what the watcher has handed out; later events reach it through the
      // watcher, and the id lets the client resume from here.
      lastSent = options.hub.seq;
      res.write(`id: ${lastSent}\nevent: ready\ndata: {}\n\n`);
    }
  } catch (error) {
    // The headers are sent, so the failure cannot become an error response: end the stream and let
    // the client reconnect with its cursor.
    logger.error("Execution change stream catch-up failed", error);
    close();
    res.end();
    return;
  }
  catchingUp = false;
  for (const event of queued.splice(0)) send(event);

  const heartbeat = setInterval(() => {
    if (!closed) res.write(": heartbeat\n\n");
  }, options.heartbeatMs ?? STREAM_HEARTBEAT_MS);
  const recheck = setInterval(() => {
    options
      .sessionStillValid(req)
      .then((valid) => {
        if (valid || closed) return;
        res.write("event: close\ndata: {}\n\n");
        close();
        res.end();
      })
      .catch(() => {
        close();
        res.end();
      });
  }, options.recheckMs);
  timers.push(heartbeat, recheck);
}

/**
 * The signed-in user's changes after a cursor, for clients that cannot hold a stream. Without a
 * cursor the answer is only the position to poll from, as a new stream's `ready`; `reset` carries the
 * position too, so a client that reloads knows where to continue.
 */
export function changesAfter(
  feed: ExecutionChangeRepository,
  userId: string,
  cursor: number | undefined,
):
  | { reset: true; lastSeq: number }
  | {
      reset: false;
      events: Array<{ seq: number; executionId: string; kind: string }>;
      lastSeq: number;
    } {
  // The position is read first and the events only up to it: an event committed in between lies
  // after the returned position and comes with the next poll.
  const latest = feed.latestSeq();
  if (cursor === undefined) return { reset: false, events: [], lastSeq: latest };
  if (feed.isExpired(cursor)) return { reset: true, lastSeq: latest };
  const events = feed.forUserAfter(userId, cursor, CATCH_UP_LIMIT, latest);
  return {
    reset: false,
    events: events.map((event) => ({
      seq: event.seq,
      executionId: event.executionId,
      kind: event.kind,
    })),
    // Past the last event of this user and every other user's, so the next poll starts after them.
    lastSeq: events.length === CATCH_UP_LIMIT ? events[events.length - 1].seq : latest,
  };
}

let hub: ExecutionChangeHub | null = null;

/** This process's watcher (created on first use over the process's database). */
export function getExecutionChangeHub(): ExecutionChangeHub {
  if (!hub) hub = new ExecutionChangeHub(new ExecutionChangeRepository(getSqliteInstance()));
  return hub;
}
