import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { LocalVmRuntime, LocalVmIdentity } from "./local-vm-runtime.js";
import {
  WORKSPACE_INSTALL_SCRIPT,
  WORKSPACE_PROBE_SCRIPT,
  WORKSPACE_LOCAL_BOOTSTRAP_SCRIPT,
  WORKSPACE_CONFIGURE_SCRIPT,
  WORKSPACE_START_SCRIPT,
  WORKSPACE_HEALTH_SCRIPT,
  loadWorkspacePayload,
  workspaceInstallInput,
  type WorkspacePayload,
} from "../../workspace-service/src/bootstrap.mjs";

export interface GuestAssets {
  payload: WorkspacePayload;
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
  const [payload, proxy] = await Promise.all([
    loadWorkspacePayload(
      fileURLToPath(new URL("workspace-payload/", import.meta.url)),
      process.arch,
    ),
    readFile(new URL("workspace-payload/service/guest-proxy.mjs", import.meta.url), "utf8"),
  ]);
  return { payload, proxy };
}

export const GUEST_COMMANDS = {
  install: ["/bin/sh", "-c", WORKSPACE_INSTALL_SCRIPT],
  probe: ["/bin/sh", "-c", WORKSPACE_PROBE_SCRIPT],
  bootstrap: ["/bin/sh", "-c", WORKSPACE_LOCAL_BOOTSTRAP_SCRIPT],
  configure: ["/bin/sh", "-c", WORKSPACE_CONFIGURE_SCRIPT],
  "start-service": ["/bin/sh", "-c", WORKSPACE_START_SCRIPT],
  health: ["/bin/sh", "-c", WORKSPACE_HEALTH_SCRIPT],
} as const;
export const VERIFIED_GUEST_FAILURE_EXIT = 200;

export async function installGuest(
  runtime: LocalVmRuntime,
  identity: LocalVmIdentity,
  assets: GuestAssets,
): Promise<void> {
  await runtime.runFixedGuest(identity, "install", workspaceInstallInput(assets.payload));
}
