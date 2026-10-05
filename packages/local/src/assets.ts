import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SbxRuntime, SandboxIdentity } from "./sbx-runtime.js";

export interface GuestAssets {
  worker: Buffer;
  proxy: string;
}

export function keychainAsset(): string {
  return fileURLToPath(new URL("keychain-helper", import.meta.url));
}

export function runtimeControlAsset(): string {
  return fileURLToPath(
    new URL(
      /\/src\/assets\.(?:ts|js)$/.test(new URL(import.meta.url).pathname)
        ? "../dist/runtime-control-helper"
        : "runtime-control-helper",
      import.meta.url,
    ),
  );
}

export function runtimeApiAsset(): string {
  return fileURLToPath(new URL("runtime-api.js", import.meta.url));
}

/** Assets come from the installed release, never a server response. */
export async function guestAssets(): Promise<GuestAssets> {
  const [worker, proxy] = await Promise.all([
    readFile(new URL("guest-worker.js", import.meta.url)),
    readFile(new URL("guest-proxy.js", import.meta.url), "utf8"),
  ]);
  return { worker, proxy };
}

const INSTALL =
  "const f=require('node:fs');const p='/tmp/moira-local-runtime';f.mkdirSync(p,{recursive:true,mode:448});f.writeFileSync(p+'/worker.mjs',f.readFileSync(0),{mode:384});";
export const GUEST_INSTALL_COMMAND = ["node", "-e", INSTALL] as const;
export const GUEST_WORKER_COMMAND = ["node", "/tmp/moira-local-runtime/worker.mjs"] as const;
export const VERIFIED_GUEST_FAILURE_EXIT = 200;

export async function installGuest(
  runtime: SbxRuntime,
  identity: SandboxIdentity,
  assets: GuestAssets,
): Promise<void> {
  // This fixed installer runs inside the VM. Workload requests are delivered separately as JSON.
  await runtime.guest(identity, GUEST_INSTALL_COMMAND, assets.worker);
}
