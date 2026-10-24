import { describe, expect, jest, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { LocalDaemon } from "../../../packages/local/src/daemon.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalRelay, LocalDeviceAuthorityFailure } from "../../../packages/local/src/relay.js";
import { LocalRefusal } from "../../../packages/local/src/policy.js";

function fixture() {
  const connection = {
    origin: "https://moira.example",
    credential: "a".repeat(43),
    userId: "owner",
    deviceId: randomUUID(),
    deviceGeneration: 1,
    connectionId: randomUUID(),
    pairingId: randomUUID(),
  };
  const manager = {
    close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    release: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stopWork: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    records: {
      state: {
        read: async () => connection,
        write: async (_key: string, value: unknown) => Object.assign(connection, value),
      },
      policy: async () => ({
        deviceId: connection.deviceId,
        enabled: true,
      }),
      policyOrNull: async () => ({ enabled: true }),
      deviceIdentity: async () => ({ deviceId: connection.deviceId, label: "controller" }),
    },
  } as unknown as LocalManager;
  const confirmed = jest.fn<(signal?: AbortSignal) => ReturnType<LocalRelay["confirmed"]>>();
  const relay = {
    confirmed,
    isUnavailable: (error: unknown) =>
      error instanceof LocalRefusal && error.code === "LOCAL_RELAY_UNAVAILABLE",
  } as unknown as LocalRelay;
  const controllerClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const controllerDetach = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const controllerRetire = jest.fn<() => Promise<void>>().mockImplementation(async () => {
    await manager.stopWork();
  });
  const remoteClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const options = {
    report: jest.fn(),
    startController: async () => ({
      socketPath: "/private/controller.sock",
      connectionId: connection.connectionId,
      incarnation: "b".repeat(64),
      close: controllerClose,
      detach: controllerDetach,
      retire: controllerRetire,
    }),
    startRemote: () => ({ close: remoteClose, whenConnected: async () => undefined }),
  };
  return {
    manager,
    relay,
    confirmed,
    connection,
    controllerClose,
    controllerRetire,
    remoteClose,
    options,
  };
}

describe("Local controller survives observation loss without native replay", () => {
  test("service observation loss releases attachments before draining original controller work", async () => {
    const f = fixture(),
      abort = new AbortController();
    f.confirmed.mockResolvedValue(f.connection);
    let settle!: () => void;
    const attachment = new Promise<void>((resolve) => {
      settle = resolve;
    });
    (f.manager.release as ReturnType<typeof jest.fn<() => Promise<void>>>).mockImplementation(
      async () => {
        settle();
      },
    );
    let drained = false;
    f.controllerClose.mockImplementation(async () => {
      await attachment;
      drained = true;
    });
    const daemon = new LocalDaemon(f.manager, f.relay, {
      ...f.options,
      wait: async () => {
        abort.abort();
      },
    });
    await daemon.run(abort.signal, () => false);
    expect(drained).toBe(true);
    expect(daemon.status).toEqual({ controlPlane: "offline", code: null });
    expect(f.controllerRetire).not.toHaveBeenCalled();
    expect(f.manager.stopWork).not.toHaveBeenCalled();
    expect(f.manager.close).not.toHaveBeenCalled();
  });
  test("a paired controller without Local capability remains connected without opening or stopping an SDK", async () => {
    const f = fixture();
    f.manager.records.policyOrNull = async () => null;
    f.manager.records.policy = async () => {
      throw new Error("Local SDK policy must not be required");
    };
    f.confirmed.mockResolvedValue(f.connection);
    const daemon = new LocalDaemon(f.manager, f.relay, f.options);
    expect(await daemon.cycle()).toBe(true);
    expect(daemon.status).toEqual({ controlPlane: "connected", code: null });
    expect(f.manager.stopWork).not.toHaveBeenCalled();
    expect(f.controllerClose).not.toHaveBeenCalled();
  });
  test("saved paired owner exposes IPC while cloud is offline and does not stop existing hardware", async () => {
    const f = fixture();
    f.confirmed.mockRejectedValueOnce(new LocalRefusal("LOCAL_RELAY_UNAVAILABLE", "private"));
    const daemon = new LocalDaemon(f.manager, f.relay, f.options);
    expect(await daemon.cycle()).toBe(false);
    expect(daemon.status).toEqual({ controlPlane: "offline", code: "LOCAL_RELAY_UNAVAILABLE" });
    expect(f.manager.stopWork).not.toHaveBeenCalled();
    expect(f.controllerClose).not.toHaveBeenCalled();
    expect(f.remoteClose).not.toHaveBeenCalled();
  });
  test("confirmed revocation closes remote authority without manufacturing a physical stop", async () => {
    const f = fixture();
    f.confirmed.mockRejectedValueOnce(new LocalDeviceAuthorityFailure("LOCAL_UNAUTHORIZED"));
    const daemon = new LocalDaemon(f.manager, f.relay, f.options);
    expect(await daemon.cycle()).toBe(false);
    expect(daemon.status).toEqual({ controlPlane: "disabled", code: "LOCAL_UNAUTHORIZED" });
    expect(f.manager.stopWork).not.toHaveBeenCalled();
    expect(f.controllerClose).toHaveBeenCalledTimes(1);
    expect(f.controllerRetire).not.toHaveBeenCalled();
    expect(f.remoteClose).toHaveBeenCalledTimes(1);
    f.confirmed.mockRejectedValueOnce(
      new LocalRefusal("LOCAL_RELAY_UNAVAILABLE", "offline after revocation"),
    );
    expect(await daemon.cycle()).toBe(false);
    expect(f.controllerClose).toHaveBeenCalledTimes(1);
    expect(f.remoteClose).toHaveBeenCalledTimes(1);
  });
  test("malformed observation is a fault, and explicit shutdown closes independent owner", async () => {
    const f = fixture(),
      abort = new AbortController();
    f.confirmed.mockRejectedValueOnce(new SyntaxError("private response"));
    f.confirmed.mockImplementationOnce(async () => {
      abort.abort();
      return f.connection;
    });
    const wait = jest
      .fn<(_ms: number, _signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);
    await new LocalDaemon(f.manager, f.relay, { ...f.options, wait }).run(abort.signal);
    expect(f.options.report.mock.calls[0]).toEqual([
      { controlPlane: "faulted", code: "LOCAL_PROTOCOL_INVALID" },
    ]);
    expect(JSON.stringify(f.options.report.mock.calls)).not.toContain("private response");
    expect(f.manager.close).toHaveBeenCalledTimes(1);
    expect(f.controllerClose).toHaveBeenCalledTimes(1);
    expect(f.controllerRetire.mock.invocationCallOrder[0]).toBeLessThan(
      (f.manager.close as ReturnType<typeof jest.fn>).mock.invocationCallOrder[0],
    );
  });
  test("shutdown retains the runner gate until endpoint namespace cleanup completes", async () => {
    const f = fixture(),
      abort = new AbortController();
    f.confirmed.mockResolvedValue(f.connection);
    let release!: () => void, arrived!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleaning = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    f.controllerClose.mockImplementation(async () => {
      arrived();
      await held;
    });
    const running = new LocalDaemon(f.manager, f.relay, {
      ...f.options,
      wait: async () => {
        abort.abort();
      },
    }).run(abort.signal);
    await cleaning;
    expect(f.manager.close).not.toHaveBeenCalled();
    release();
    await running;
    expect(f.manager.close).toHaveBeenCalledTimes(1);
    expect(f.controllerClose.mock.invocationCallOrder[0]).toBeLessThan(
      (f.manager.close as ReturnType<typeof jest.fn>).mock.invocationCallOrder[0],
    );
  });
  test("remote shutdown failure still cleans the endpoint; unknown custody keeps the runner gate", async () => {
    const f = fixture(),
      abort = new AbortController();
    f.confirmed.mockResolvedValue(f.connection);
    f.remoteClose.mockRejectedValue(new Error("Controlled transport closure failure"));
    f.controllerRetire.mockRejectedValue(
      new LocalRefusal("LOCAL_CUSTODY_UNCONFIRMED", "Native custody remains pending."),
    );
    f.controllerClose.mockRejectedValue(
      new LocalRefusal("LOCAL_CUSTODY_UNCONFIRMED", "Native custody remains pending."),
    );
    const daemon = new LocalDaemon(f.manager, f.relay, {
      ...f.options,
      wait: async () => {
        abort.abort();
      },
    });
    await expect(daemon.run(abort.signal)).rejects.toBeInstanceOf(AggregateError);
    expect(daemon.status).toEqual({
      controlPlane: "faulted",
      code: "LOCAL_CONTROLLER_SHUTDOWN_UNCONFIRMED",
    });
    expect(f.controllerRetire).toHaveBeenCalledTimes(1);
    expect(f.controllerClose).toHaveBeenCalledTimes(1);
    expect(f.manager.close).not.toHaveBeenCalled();
  });
});
