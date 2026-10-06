import { createHash } from "node:crypto";
import type { LocalVmRuntime } from "./local-vm-runtime.js";
import { LocalRefusal, type LocalPolicy } from "./policy.js";
import { SbxRuntime } from "./sbx-runtime.js";
import { runProcess, type RunProcess } from "./process.js";

/** Adapt the verified backend without leaking its native control API into VM consumers. */
export function adaptSbxRuntime(runtime: SbxRuntime): LocalVmRuntime {
  return {
    boundary: {
      verifyConfiguration: () => runtime.verifySettings(),
      verify: async (identity, expectedNetworkDigest) => {
        await runtime.verifySettings();
        await runtime.verifyBoundary(identity);
        if (expectedNetworkDigest !== undefined) {
          const observed = createHash("sha256")
            .update(await runtime.networkPolicy(identity))
            .digest("hex");
          if (observed !== expectedNetworkDigest)
            throw new LocalRefusal("LOCAL_NETWORK_CHANGED", "The sandbox network policy changed.");
        }
      },
      configureNetwork: async (identity, port) =>
        createHash("sha256")
          .update(await runtime.configureBroker(identity, port))
          .digest("hex"),
    },
    list: () => runtime.list(),
    inspectExact: (identity) => runtime.exact(identity),
    create: (name) => runtime.create(name),
    start: (identity) => runtime.start(identity),
    stop: (identity) => runtime.stop(identity),
    remove: (identity) => runtime.remove(identity),
    runFixedGuest: async (identity, entrypoint, input, timeoutMs, signal, admission) => {
      if (entrypoint !== "installer" && entrypoint !== "worker")
        throw new LocalRefusal("LOCAL_GUEST_COMMAND_INVALID", "Unknown fixed guest entrypoint.");
      return runtime.runFixedGuest(identity, entrypoint, input, timeoutMs, signal, admission);
    },
  };
}

/** Initial backend remains the supported SBX runtime; selection is local, never a relay field. */
export function createLocalVmRuntime(
  policy: LocalPolicy,
  options: { run?: RunProcess; prepareCredentials?: () => Promise<void> } = {},
): LocalVmRuntime {
  return adaptSbxRuntime(
    new SbxRuntime(policy, options.run ?? runProcess, options.prepareCredentials),
  );
}
