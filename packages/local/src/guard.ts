import { fork } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { PrivateState } from "./private-state.js";
import { LocalRecords } from "./space-record.js";
import { SbxRuntime, type SandboxIdentity } from "./sbx-runtime.js";
import { LocalRefusal, requireLocalGrant } from "./policy.js";

export interface SpaceGuard {
  stop(): Promise<void>;
}
export type StartGuard = (root: string, id: string) => Promise<SpaceGuard>;

/** An independent host process owns the time limit and observes parent death through IPC. */
export const startGuard: StartGuard = (root, id) =>
  new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./guard.js", import.meta.url)), [root, id], {
      execArgv: [],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let ready = false;
    const timer = setTimeout(() => {
      if (child.connected) child.disconnect();
      reject(
        new LocalRefusal(
          "LOCAL_GUARD_UNAVAILABLE",
          "The independent local work guard did not start.",
        ),
      );
    }, 45_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        new LocalRefusal(
          "LOCAL_GUARD_UNAVAILABLE",
          "The independent local work guard could not start.",
        ),
      );
    });
    child.once("exit", () => {
      clearTimeout(timer);
      if (!ready)
        reject(
          new LocalRefusal(
            "LOCAL_GUARD_UNAVAILABLE",
            "The independent local work guard exited before readiness.",
          ),
        );
    });
    child.on("message", (message) => {
      if (message !== "ready" || ready) return;
      ready = true;
      clearTimeout(timer);
      resolve({
        stop: () =>
          new Promise<void>((done, fail) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              done();
              return;
            }
            const deadline = setTimeout(
              () =>
                fail(
                  new LocalRefusal(
                    "LOCAL_STOP_PENDING",
                    "Local sandbox shutdown is still pending.",
                  ),
                ),
              40_000,
            );
            child.once("exit", (code) => {
              clearTimeout(deadline);
              if (code === 0) done();
              else
                fail(
                  new LocalRefusal(
                    "LOCAL_STOP_PENDING",
                    "The local guard could not confirm sandbox shutdown.",
                  ),
                );
            });
            if (child.connected) child.send("stop");
          }),
      });
    });
  });

async function runGuard(root: string, id: string): Promise<void> {
  const records = new LocalRecords(await PrivateState.open(root));
  const space = await records.get(id);
  if (!space?.runtimeId) throw new Error("Local guard has no owned sandbox");
  const identity: SandboxIdentity = { name: space.name, runtimeId: space.runtimeId };
  const initial = await records.policy();
  const runtime = new SbxRuntime(initial);
  const controller = new AbortController();
  let stopping: Promise<void> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      if (poll) clearTimeout(poll);
      controller.abort();
      await runtime.stop(identity);
    })();
    return stopping;
  };
  const requestStop = () => {
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("disconnect", requestStop);
  process.on("message", (message) => {
    if (message === "stop") requestStop();
  });
  process.once("SIGTERM", requestStop);
  process.once("SIGINT", requestStop);
  try {
    requireLocalGrant(initial, space.repositoryId, Date.now());
    if (space.desiredState !== "running") throw new Error("No local work grant");
    const keepalive = runtime.guest(
      identity,
      ["sleep", String(Math.ceil((initial.leaseUntil - Date.now()) / 1000))],
      undefined,
      Math.max(1000, initial.leaseUntil - Date.now()),
      controller.signal,
    );
    let ended = false;
    void keepalive.then(
      () => {
        ended = true;
        requestStop();
      },
      () => {
        ended = true;
        requestStop();
      },
    );
    const check = async () => {
      try {
        const policy = await records.policy();
        const current = await records.get(id);
        requireLocalGrant(policy, space.repositoryId, Date.now());
        if (
          !current ||
          current.runtimeId !== identity.runtimeId ||
          current.desiredState !== "running" ||
          !process.connected
        ) {
          requestStop();
          return;
        }
        poll = setTimeout(() => {
          void check();
        }, 1000);
      } catch {
        requestStop();
      }
    };
    await check();
    for (let attempt = 0; attempt < 40 && !ended && !stopping; attempt++) {
      if ((await runtime.exact(identity))?.status === "running") {
        process.send?.("ready");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    requestStop();
  } catch {
    await stop();
    throw new Error("Local work guard could not be established");
  }
}

if (
  process.argv[1] &&
  new URL(import.meta.url).pathname.endsWith("/guard.js") &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runGuard(process.argv[2], process.argv[3]).catch(() => process.exit(1));
}
