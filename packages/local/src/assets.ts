import { readFile } from "node:fs/promises";
import type { SbxRuntime, SandboxIdentity } from "./sbx-runtime.js";

export interface GuestAssets {
  worker: Buffer;
  proxy: string;
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

export async function installGuest(
  runtime: SbxRuntime,
  identity: SandboxIdentity,
  assets: GuestAssets,
): Promise<void> {
  // This fixed installer runs inside the VM. Workload requests are delivered separately as JSON.
  await runtime.guest(identity, ["node", "-e", INSTALL], assets.worker);
}
