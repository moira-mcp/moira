/**
 * Process-wide access to the active extension registry, plus the on-disk snapshot that serves
 * consumers running outside this process.
 *
 * Why a provider rather than threading a parameter through every caller: the graph validator is
 * constructed in a dozen places across the MCP server, the backend, shared services and storage,
 * and a caller that silently keeps the old constructor would reject a workflow every other caller
 * accepts. The registry is still an explicit input — `new GraphValidator(path, { extensionRegistry })`
 * always wins; the provider only supplies the process default when nothing was passed.
 *
 * Consumers in a different process (the `moira-workflow` CLI) cannot read this module at all. For
 * them the active registry is published as a snapshot file in the state directory; its absence is a
 * normal state meaning "custom types cannot be resolved here", not an error.
 */

import * as fs from "fs";
import * as path from "path";
// Imported directly rather than through the shared index to avoid auth side effects, as the
// validator does for the same reason.
import {
  getDbPath,
  getExtensionRunnerUrl as getConfiguredExtensionRunnerUrl,
} from "@mcp-moira/shared/config/env";
import { createLogger } from "@mcp-moira/shared/logging/logger";
import { ExtensionRegistry } from "./extension-registry.js";
import type { IExtensionRunnerClient } from "./extension-runner-client.js";
import {
  EXTENSION_API_VERSION,
  ExtensionRegistrySnapshot,
  ExtensionNodeDeclaration,
  ExtensionManifestRejection,
} from "./extension-contract.js";

/** File name of the published snapshot inside the state directory. */
export const EXTENSION_REGISTRY_SNAPSHOT_FILE = "extension-registry.json";

let activeRegistry: ExtensionRegistry | null = null;
let activeRunnerClient: IExtensionRunnerClient | null = null;

/**
 * Where a refused manifest is reported.
 *
 * A rejection carries the only explanation an extension author will ever get: the bundle is hosted
 * by the runner and looks healthy there, while its node types simply do not appear in Moira. If the
 * reasons are computed and dropped, the author sees silence. Reporting belongs here rather than in
 * each server's start-up routine, because both routines must do it and a passage repeated in two
 * places is exactly where one of them forgets.
 */
export type ExtensionDiagnosticLog = (message: string, fields: Record<string, unknown>) => void;

function defaultDiagnosticLog(message: string, fields: Record<string, unknown>): void {
  // Built on use, not at module load: this module is imported by processes that must not acquire a
  // logger transport merely by being loaded.
  createLogger({ component: "Extensions" }).warn(message, fields);
}

/** Report every refused manifest with its reasons, one line per bundle. */
function reportRejections(
  rejected: ExtensionManifestRejection[],
  log: ExtensionDiagnosticLog,
): void {
  for (const rejection of rejected) {
    log("Extension manifest refused; its node types and settings are not available", {
      extension: rejection.manifestName ?? "(unnamed manifest)",
      reasons: rejection.reasons,
    });
  }
}

/** State directory: the directory holding the database, as everything else persistent does. */
export function getExtensionStateDir(): string {
  return path.dirname(path.resolve(getDbPath()));
}

export function extensionRegistrySnapshotPath(stateDir: string = getExtensionStateDir()): string {
  return path.join(stateDir, EXTENSION_REGISTRY_SNAPSHOT_FILE);
}

/**
 * Publish the snapshot for out-of-process consumers. Failure to write is reported to the caller
 * rather than thrown: an unwritable state directory must not stop the application from serving
 * workflows, and the resulting missing snapshot is itself a defined state.
 */
export function writeExtensionRegistrySnapshot(
  registry: ExtensionRegistry,
  stateDir: string = getExtensionStateDir(),
): { written: boolean; reason?: string } {
  const target = extensionRegistrySnapshotPath(stateDir);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(registry.snapshot(), null, 2)}\n`, "utf-8");
    return { written: true };
  } catch (error) {
    return { written: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Remove a published snapshot; a missing file is already the desired state. */
export function removeExtensionRegistrySnapshot(stateDir: string = getExtensionStateDir()): {
  removed: boolean;
  reason?: string;
} {
  const target = extensionRegistrySnapshotPath(stateDir);
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return { removed: true };
  } catch (error) {
    return { removed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Make a registry the process default, or clear it — which is what an installation without
 * extensions looks like. Publishing the snapshot is a separate, explicit step
 * (`publishExtensionRegistry`): whoever owns the registry lifecycle decides when the on-disk
 * projection should change, and nothing writes to the state directory as a side effect of
 * assigning a variable.
 */
export function setActiveExtensionRegistry(registry: ExtensionRegistry | null): void {
  activeRegistry = registry;
}

/**
 * Publish the current process default for out-of-process consumers: write the snapshot when a
 * registry is active, remove it when none is. Returns what happened so the caller can log a failed
 * write instead of discovering a stale file later.
 */
export function publishExtensionRegistry(stateDir: string = getExtensionStateDir()): {
  published: boolean;
  removed: boolean;
  reason?: string;
} {
  const registry = activeRegistry;
  if (registry) {
    const result = writeExtensionRegistrySnapshot(registry, stateDir);
    return { published: result.written, removed: false, reason: result.reason };
  }
  const result = removeExtensionRegistrySnapshot(stateDir);
  return { published: false, removed: result.removed, reason: result.reason };
}

/**
 * Configured address of the extension runner, or null when this installation has none. An absent
 * address is the ordinary state of an installation without extensions, not a misconfiguration.
 */
export function getExtensionRunnerUrl(): string | null {
  return getConfiguredExtensionRunnerUrl();
}

/** The process default, or null when no extensions are configured in this process. */
export function getActiveExtensionRegistry(): ExtensionRegistry | null {
  return activeRegistry;
}

/**
 * The runner client belongs to the process for the same reason the registry does: the executor is
 * constructed where the request arrives, not where the runner address is read, and an executor
 * built without it would refuse at run time every custom node validation had just accepted. An
 * explicitly passed client still wins.
 */
export function setActiveExtensionRunnerClient(client: IExtensionRunnerClient | null): void {
  activeRunnerClient = client;
}

/** The process default runner client, or null when this installation has no runner. */
export function getActiveExtensionRunnerClient(): IExtensionRunnerClient | null {
  return activeRunnerClient;
}

/**
 * Registry reconstructed from a published snapshot, for a process that cannot ask the live one.
 * A snapshot carries data-only node declarations, including bounded schemas, so the CLI applies the
 * same configuration contract without importing extension code or receiving settings/permissions.
 */
export function readExtensionRegistrySnapshot(
  stateDir: string = getExtensionStateDir(),
): { registry: ExtensionRegistry; snapshot: ExtensionRegistrySnapshot } | null {
  const source = extensionRegistrySnapshotPath(stateDir);
  let parsed: unknown;
  try {
    if (!fs.existsSync(source)) return null;
    parsed = JSON.parse(fs.readFileSync(source, "utf-8"));
  } catch {
    // A damaged snapshot is treated exactly like an absent one: the CLI must not turn a local file
    // problem into a verdict about the workflow it was asked to validate.
    return null;
  }

  const snapshot = parsed as Partial<ExtensionRegistrySnapshot>;
  if (
    snapshot?.apiVersion !== EXTENSION_API_VERSION ||
    typeof snapshot.generatedAt !== "string" ||
    !Array.isArray(snapshot.extensions)
  ) {
    return null;
  }

  const registry = new ExtensionRegistry("snapshot");
  for (const extension of snapshot.extensions) {
    if (
      !extension ||
      typeof extension.name !== "string" ||
      typeof extension.version !== "string" ||
      !Array.isArray(extension.nodes)
    ) {
      return null;
    }
    const registration = registry.register({
      apiVersion: EXTENSION_API_VERSION,
      name: extension.name,
      version: extension.version,
      entrypoint: "(from snapshot)",
      nodes: extension.nodes as ExtensionNodeDeclaration[],
    });
    if (!registration.registered) return null;
  }

  return { registry, snapshot: snapshot as ExtensionRegistrySnapshot };
}

/**
 * Fill the active registry from a running extension runner and publish the result.
 *
 * The registry object is mutated rather than replaced, because consumers take it once when they are
 * constructed. A runner that cannot be reached leaves the previous state untouched and says so: an
 * unreachable runner must not silently erase the custom types an installation already had.
 */
export async function syncExtensionRegistryFromRunner(
  client: { listExtensions(): Promise<unknown[]> },
  options: { stateDir?: string; publish?: boolean; log?: ExtensionDiagnosticLog } = {},
): Promise<{
  synced: boolean;
  registered: string[];
  rejected: ExtensionManifestRejection[];
  reason?: string;
}> {
  const registry = activeRegistry ?? new ExtensionRegistry();
  activeRegistry = registry;

  let manifests: unknown[];
  try {
    manifests = await client.listExtensions();
  } catch (error) {
    registry.noteKnowledgeSource("unreachable");
    return {
      synced: false,
      registered: [],
      rejected: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  // The service answered: from here the registry's emptiness means "this installation has no such
  // extension", which is the only state in which a consumer may say so.
  registry.noteKnowledgeSource("live");
  const result = registry.replaceAll(manifests);
  reportRejections(result.rejected, options.log ?? defaultDiagnosticLog);
  if (options.publish !== false) {
    publishExtensionRegistry(options.stateDir ?? getExtensionStateDir());
  }
  return { synced: true, registered: result.registered, rejected: result.rejected };
}

/**
 * Everything a Moira process must do about extensions at start-up, in one place.
 *
 * It exists as a function rather than as a passage inside each server's start-up routine because
 * both processes must end in the same state: their own registry, and — when a runner is configured
 * — the same client used both to fill that registry and to execute custom nodes. A passage repeated
 * in two start-up routines has no way to be observed, and the one place a step could be forgotten
 * is exactly where it was.
 *
 * The runner is optional: an installation without one, or with one that cannot be reached, ends
 * with a defined empty state instead of a failed start.
 */
export async function initializeExtensionsForProcess(options: {
  /** Address of the runner, or null when this installation has none. */
  runnerUrl: string | null;
  /** Builds the client; the caller owns the transport implementation. */
  createClient: (
    baseUrl: string,
  ) => IExtensionRunnerClient & { listExtensions(): Promise<unknown[]> };
  /** Whether this process publishes the snapshot; only one writer should. */
  publishSnapshot: boolean;
  stateDir?: string;
  /** Where refused manifests are reported; the process logger by default. */
  log?: ExtensionDiagnosticLog;
}): Promise<{
  publication?: { published: boolean; removed: boolean; reason?: string };
  synced: boolean;
  registered: string[];
  rejected: ExtensionManifestRejection[];
  reason?: string;
}> {
  const stateDir = options.stateDir ?? getExtensionStateDir();
  // Until the service has actually answered, the registry says so: an empty registry that calls
  // itself live would let every consumer conclude "this extension is not installed" — on an
  // installation that has nowhere to ask, and on one whose service simply starts a moment later.
  setActiveExtensionRegistry(
    new ExtensionRegistry(options.runnerUrl ? "unreachable" : "unconfigured"),
  );
  setActiveExtensionRunnerClient(null);

  if (!options.runnerUrl) {
    const publication = options.publishSnapshot ? publishExtensionRegistry(stateDir) : undefined;
    return { publication, synced: false, registered: [], rejected: [] };
  }

  const client = options.createClient(options.runnerUrl);
  // Set before filling: the process must be able to execute exactly what its registry accepts, and
  // an unreachable runner leaves a client that will report its own unavailability per call rather
  // than a process that cannot execute custom nodes at all.
  setActiveExtensionRunnerClient(client);

  const sync = await syncExtensionRegistryFromRunner(client, {
    stateDir,
    // This helper owns publication so it can return the result of the final write to the caller.
    publish: false,
    log: options.log,
  });
  const publication = options.publishSnapshot
    ? sync.synced
      ? publishExtensionRegistry(stateDir)
      : undefined
    : undefined;
  return { publication, ...sync };
}
