import { describe, expect, jest, test } from "@jest/globals";
import { LocalDaemon } from "../../../packages/local/src/daemon.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalRelay, LocalDeviceAuthorityFailure } from "../../../packages/local/src/relay.js";
import { LocalCompanion } from "../../../packages/local/src/web-control.js";
import { LocalRefusal } from "../../../packages/local/src/policy.js";

function fixture() {
  const manager = {
    close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as LocalManager;
  const relay = {
    isUnavailable: (error: unknown) =>
      error instanceof LocalRefusal && error.code === "LOCAL_RELAY_UNAVAILABLE",
  } as LocalRelay;
  const cycle = jest.fn<(signal?: AbortSignal) => Promise<boolean>>();
  const pause = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const companion = { cycle, pause } as unknown as LocalCompanion;
  const report = jest.fn();
  const daemon = new LocalDaemon(manager, relay, { companion, report });
  return { manager, relay, cycle, pause, daemon, companion, report };
}

describe("Local daemon owns connection policy independently of VM admission", () => {
  test.each(["LOCAL_UNAUTHORIZED", "LOCAL_RELAY_REFUSED", "LOCAL_GENERATION_CONFLICT"])(
    "scoped refusal %s suspends claims without pausing hardware",
    async (code) => {
      const f = fixture();
      f.cycle.mockRejectedValueOnce(new LocalRefusal(code, "private ignored message"));
      expect(await f.daemon.cycle()).toBe(false);
      expect(f.daemon.status).toEqual({ controlPlane: "faulted", code });
      expect(f.pause).not.toHaveBeenCalled();
      expect(f.manager.close).not.toHaveBeenCalled();
      expect(JSON.stringify(f.report.mock.calls)).not.toContain("private ignored message");
    },
  );
  test("validated device revocation stops work but leaves management available", async () => {
    const f = fixture();
    f.cycle.mockRejectedValueOnce(new LocalDeviceAuthorityFailure("LOCAL_UNAUTHORIZED"));
    expect(await f.daemon.cycle()).toBe(false);
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.manager.close).not.toHaveBeenCalled();
    expect(f.daemon.status).toEqual({ controlPlane: "disabled", code: "LOCAL_UNAUTHORIZED" });
  });
  test("offline transport reconnects without shutdown; only explicit abort closes manager", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.cycle.mockRejectedValueOnce(new LocalRefusal("LOCAL_RELAY_UNAVAILABLE", "private"));
    f.cycle.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      controller.abort();
      return true;
    });
    const wait = jest
      .fn<(ms: number, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);
    const daemon = new LocalDaemon(f.manager, f.relay, {
      companion: f.companion,
      wait,
      report: f.report,
    });
    await daemon.run(controller.signal);
    expect(wait).toHaveBeenCalledWith(1000, controller.signal);
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.manager.close).toHaveBeenCalledTimes(1);
    expect(f.report.mock.calls).toEqual([
      [{ controlPlane: "offline", code: "LOCAL_RELAY_UNAVAILABLE" }],
      [{ controlPlane: "connected", code: null }],
    ]);
  });
  test("malformed authority response retries with bounded backoff and never becomes transport revocation", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.cycle.mockRejectedValueOnce(new SyntaxError("private response contents"));
    f.cycle.mockImplementationOnce(async () => {
      controller.abort();
      return true;
    });
    const wait = jest
      .fn<(ms: number, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);
    const daemon = new LocalDaemon(f.manager, f.relay, {
      companion: f.companion,
      wait,
      report: f.report,
    });
    await daemon.run(controller.signal);
    expect(wait).toHaveBeenCalledWith(30_000, controller.signal);
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.report.mock.calls[0]).toEqual([
      { controlPlane: "faulted", code: "LOCAL_PROTOCOL_INVALID" },
    ]);
  });
});
