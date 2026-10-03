/**
 * The overview's live connection, apart from React so it can be driven in tests.
 *
 * One tab per browser — the leader, chosen through Web Locks — holds the server's event stream and
 * passes every change, and the state of the connection, to the other tabs over a
 * `BroadcastChannel`. When the leader's tab closes its lock goes to the next tab, which resumes the
 * stream from the last change any tab saw. The stream is held while at least one tab is visible;
 * when every tab is hidden the leader closes it and, once a tab is shown again, catches up from its
 * cursor. A stream counts as working only once the server confirms it (`ready`, or a change): one
 * whose headers pass but whose events do not — a proxy that buffers the response or cuts it — fails
 * after a timeout like one that never opens. After three such failures in a row the leader polls the
 * change feed every 15 seconds instead and tries the stream again after five minutes.
 * Without Web Locks or `BroadcastChannel` every tab leads itself.
 */

import type { OverviewChange, OverviewChanges } from "../../services/api-client";

/** How the page is kept current, as the indicator says it. */
export type LiveState = "connecting" | "live" | "reconnecting" | "polling";

/** What the page is told: a change of one run, or that it must reload everything. */
export type LiveMessage = { type: "change"; change: OverviewChange } | { type: "reset" };

/** The part of `EventSource` the connection uses. */
export interface StreamLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

/** The part of `BroadcastChannel` the connection uses. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

/** The part of the Web Locks API the connection uses. */
export interface LocksLike {
  request(name: string, callback: () => Promise<void>): Promise<void>;
}

export interface LiveDependencies {
  /** Open the stream, resuming after `after` when given. */
  openStream(after: number | null): StreamLike;
  /** The change feed after a cursor; without one, only where the feed stands. */
  pollChanges(after: number | null): Promise<OverviewChanges>;
  locks: LocksLike | null;
  channel: ChannelLike | null;
  /** Whether this tab is visible now. */
  isVisible(): boolean;
  /** Call `listener` whenever this tab is shown or hidden; returns the unsubscribe. */
  onVisibilityChange(listener: () => void): () => void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
  /** Distinguishes the tabs on the channel. */
  tabId: string;
  /** Public backend/account ownership, shared by tabs of the same owner. Never a credential. */
  scope?: string;
}

export const LOCK_NAME = "moira-overview-stream";
export const CHANNEL_NAME = "moira-overview";
/** Consecutive failures to open the stream before polling. */
export const FAILURES_BEFORE_POLLING = 3;
export const POLL_INTERVAL_MS = 15_000;
/** How long polling lasts before the stream is tried again. */
export const STREAM_RETRY_AFTER_MS = 5 * 60_000;
/** How long an opened stream may take to confirm itself (`ready`) before it counts as failed. */
export const READY_TIMEOUT_MS = 10_000;
/** Pause before reopening a stream that failed, growing with each failure. */
export const RECONNECT_DELAY_MS = 1_000;

type ChannelMessage =
  | { type: "change"; change: OverviewChange }
  | { type: "reset"; seq: number | null }
  | { type: "position"; seq: number }
  | { type: "state"; state: LiveState; lastEventAt: number | null }
  | { type: "visibility"; tabId: string; visible: boolean }
  | { type: "hello"; tabId: string }
  | { type: "bye"; tabId: string };

export interface LiveSnapshot {
  state: LiveState;
  /** When the last change arrived (or the connection was confirmed); null before that. */
  lastEventAt: number | null;
}

export class LiveConnection {
  private leader = false;
  private stopped = false;
  private cursor: number | null = null;
  private stream: StreamLike | null = null;
  /** The server confirmed the open stream. */
  private confirmedStream = false;
  private readyTimer: unknown = null;
  /** Bumped whenever polling stops, so a poll answered after that is dropped. */
  private pollLoop = 0;
  private failures = 0;
  private timer: unknown = null;
  private pollTimer: unknown = null;
  private retryTimer: unknown = null;
  private polling = false;
  private releaseLock: (() => void) | null = null;
  private readonly visibleTabs = new Map<string, boolean>();
  private unsubscribeVisibility: (() => void) | null = null;
  private snapshot: LiveSnapshot = { state: "connecting", lastEventAt: null };

  constructor(
    private readonly deps: LiveDependencies,
    private readonly onMessage: (message: LiveMessage) => void,
    private readonly onSnapshot: (snapshot: LiveSnapshot) => void,
  ) {}

  /** Join the tabs: follow the leader's channel, and lead once the lock is ours. */
  start(): void {
    const { channel, locks } = this.deps;
    if (channel) channel.onmessage = (event) => this.fromChannel(event.data as ChannelMessage);
    this.unsubscribeVisibility = this.deps.onVisibilityChange(() => this.visibilityChanged());
    if (!locks || !channel) {
      this.becomeLeader();
      return;
    }
    this.post({ type: "hello", tabId: this.deps.tabId });
    this.post({ type: "visibility", tabId: this.deps.tabId, visible: this.deps.isVisible() });
    void locks
      .request(
        this.deps.scope ? `${LOCK_NAME}:${this.deps.scope}` : LOCK_NAME,
        () =>
          new Promise<void>((release) => {
            if (this.stopped) {
              release();
              return;
            }
            this.releaseLock = release;
            this.becomeLeader();
          }),
      )
      .catch(() => {
        // Web Locks refused (an insecure context): lead this tab alone.
        if (!this.stopped && !this.leader) this.becomeLeader();
      });
  }

  /** Leave: close the stream, stop the timers, hand the lock to the next tab. */
  stop(): void {
    this.stopped = true;
    this.closeStream();
    this.stopPolling();
    this.deps.clearTimer(this.timer);
    this.deps.clearTimer(this.retryTimer);
    this.deps.clearTimer(this.readyTimer);
    this.unsubscribeVisibility?.();
    this.post({ type: "bye", tabId: this.deps.tabId });
    if (this.deps.channel) this.deps.channel.onmessage = null;
    this.deps.channel?.close();
    this.releaseLock?.();
    this.releaseLock = null;
    this.leader = false;
  }

  get isLeader(): boolean {
    return this.leader;
  }

  // -------------------------------------------------------------------------------------------

  private post(message: ChannelMessage): void {
    this.deps.channel?.postMessage(message);
  }

  private setSnapshot(next: Partial<LiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    this.onSnapshot(this.snapshot);
    if (this.leader) this.post({ type: "state", ...this.snapshot });
  }

  private fromChannel(message: ChannelMessage): void {
    switch (message.type) {
      case "change":
        this.cursor = Math.max(this.cursor ?? 0, message.change.seq);
        this.onMessage({ type: "change", change: message.change });
        return;
      case "reset":
        if (message.seq !== null) this.cursor = message.seq;
        this.onMessage({ type: "reset" });
        return;
      case "position":
        this.cursor = Math.max(this.cursor ?? 0, message.seq);
        return;
      case "state":
        if (!this.leader) {
          this.snapshot = { state: message.state, lastEventAt: message.lastEventAt };
          this.onSnapshot(this.snapshot);
        }
        return;
      case "visibility":
        this.visibleTabs.set(message.tabId, message.visible);
        if (this.leader) this.holdStreamWhileVisible();
        return;
      case "hello":
        if (this.leader) {
          this.post({ type: "state", ...this.snapshot });
        } else {
          this.post({ type: "visibility", tabId: this.deps.tabId, visible: this.deps.isVisible() });
        }
        return;
      case "bye":
        this.visibleTabs.delete(message.tabId);
        if (this.leader) this.holdStreamWhileVisible();
        return;
    }
  }

  private visibilityChanged(): void {
    this.post({ type: "visibility", tabId: this.deps.tabId, visible: this.deps.isVisible() });
    if (this.leader) this.holdStreamWhileVisible();
  }

  private becomeLeader(): void {
    this.leader = true;
    // Ask the other tabs whether they are visible; until they answer, this tab's own state rules.
    this.post({ type: "hello", tabId: this.deps.tabId });
    this.holdStreamWhileVisible();
  }

  private anyTabVisible(): boolean {
    if (this.deps.isVisible()) return true;
    for (const visible of this.visibleTabs.values()) if (visible) return true;
    return false;
  }

  /** Open the stream (or keep polling) while some tab is visible; close it when none is. */
  private holdStreamWhileVisible(): void {
    if (this.stopped || !this.leader) return;
    if (!this.anyTabVisible()) {
      this.closeStream();
      this.stopPolling();
      this.deps.clearTimer(this.timer);
      this.timer = null;
      return;
    }
    if (this.polling) {
      if (this.pollTimer === null) this.schedulePoll(0);
      return;
    }
    if (!this.stream && this.timer === null) this.openStream();
  }

  private openStream(): void {
    this.setSnapshot({ state: this.failures > 0 ? "reconnecting" : "connecting" });
    this.confirmedStream = false;
    const stream = this.deps.openStream(this.cursor);
    this.stream = stream;
    // Headers alone prove nothing behind a buffering proxy: the stream must confirm itself in time.
    this.deps.clearTimer(this.readyTimer);
    this.readyTimer = this.deps.setTimer(() => {
      this.readyTimer = null;
      if (this.stream === stream && !this.confirmedStream) this.streamFailed();
    }, READY_TIMEOUT_MS);
    stream.addEventListener("ready", (event) => {
      if (this.stopped || this.stream !== stream) return;
      this.cursor = Number(event.lastEventId);
      this.confirmed();
      this.post({ type: "position", seq: this.cursor });
    });
    stream.addEventListener("change", (event) => {
      if (this.stopped || this.stream !== stream) return;
      const data = JSON.parse(event.data) as Omit<OverviewChange, "seq">;
      const change: OverviewChange = { ...data, seq: Number(event.lastEventId) };
      this.cursor = change.seq;
      this.confirmed();
      this.onMessage({ type: "change", change });
      this.post({ type: "change", change });
    });
    stream.addEventListener("reset", (event) => {
      if (this.stopped || this.stream !== stream) return;
      this.cursor = Number(event.lastEventId);
      this.confirmed();
      this.onMessage({ type: "reset" });
      this.post({ type: "reset", seq: this.cursor });
    });
    stream.onerror = () => this.streamFailed();
  }

  private confirmed(): void {
    this.confirmedStream = true;
    this.deps.clearTimer(this.readyTimer);
    this.readyTimer = null;
    this.failures = 0;
    this.setSnapshot({ state: "live", lastEventAt: this.deps.now() });
  }

  private streamFailed(): void {
    // The browser would retry on its own after a network error but not after an HTTP error; the
    // connection retries itself either way, so it can count failures and give up on the stream.
    const wasConfirmed = this.confirmedStream;
    this.closeStream();
    this.deps.clearTimer(this.readyTimer);
    this.readyTimer = null;
    if (this.stopped) return;
    if (!wasConfirmed) this.failures += 1;
    if (this.failures >= FAILURES_BEFORE_POLLING) {
      this.startPolling();
      return;
    }
    this.setSnapshot({ state: "reconnecting" });
    this.timer = this.deps.setTimer(
      () => {
        this.timer = null;
        this.holdStreamWhileVisible();
      },
      RECONNECT_DELAY_MS * Math.max(1, this.failures),
    );
  }

  private closeStream(): void {
    if (!this.stream) return;
    this.stream.onerror = null;
    this.stream.onopen = null;
    this.stream.close();
    this.stream = null;
  }

  private startPolling(): void {
    this.polling = true;
    this.setSnapshot({ state: "polling" });
    this.schedulePoll(0);
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      this.polling = false;
      this.failures = 0;
      this.stopPolling();
      this.holdStreamWhileVisible();
    }, STREAM_RETRY_AFTER_MS);
  }

  private stopPolling(): void {
    this.deps.clearTimer(this.pollTimer);
    this.pollTimer = null;
    this.pollLoop += 1;
  }

  private schedulePoll(ms: number): void {
    const loop = this.pollLoop;
    this.pollTimer = this.deps.setTimer(() => void this.poll(loop), ms);
  }

  private async poll(loop: number): Promise<void> {
    if (this.stopped || !this.polling || loop !== this.pollLoop) return;
    try {
      const answer = await this.deps.pollChanges(this.cursor);
      // Polling stopped (or started over) while this answer was on its way: another loop owns it now.
      if (this.stopped || !this.polling || loop !== this.pollLoop) return;
      if (!("events" in answer)) {
        this.cursor = answer.lastSeq;
        this.onMessage({ type: "reset" });
        this.post({ type: "reset", seq: this.cursor });
      } else {
        const hadCursor = this.cursor !== null;
        for (const change of answer.events) {
          this.onMessage({ type: "change", change });
          this.post({ type: "change", change });
        }
        this.cursor = answer.lastSeq;
        // The first answer without a cursor only says where the feed stands.
        if (!hadCursor || answer.events.length > 0)
          this.setSnapshot({ lastEventAt: this.deps.now() });
      }
    } catch {
      // A failed poll is retried at the next interval.
    }
    if (loop !== this.pollLoop) return;
    if (!this.stopped && this.polling && this.anyTabVisible()) this.schedulePoll(POLL_INTERVAL_MS);
    else this.pollTimer = null;
  }
}

/** The browser's own implementations, where they exist. */
export function browserDependencies(
  openStream: LiveDependencies["openStream"],
  pollChanges: LiveDependencies["pollChanges"],
  scope?: string,
): LiveDependencies {
  const locks =
    typeof navigator !== "undefined" && "locks" in navigator
      ? (navigator.locks as unknown as LocksLike)
      : null;
  const channel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(scope ? `${CHANNEL_NAME}:${scope}` : CHANNEL_NAME)
      : null;
  return {
    openStream,
    pollChanges,
    locks,
    channel,
    isVisible: () => document.visibilityState === "visible",
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (handle) => {
      if (handle !== null && handle !== undefined) window.clearTimeout(handle as number);
    },
    now: () => Date.now(),
    tabId: Math.random().toString(36).slice(2),
    scope,
  };
}
