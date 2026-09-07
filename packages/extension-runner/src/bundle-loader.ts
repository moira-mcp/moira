/**
 * Discovery of extension bundles in the mounted directory.
 *
 * Loading is deliberately shallow here: this module only reads and checks manifests. Extension code
 * itself is never imported into this process — it is imported by a separate handler process, so a
 * bundle that throws while loading cannot take the service down with it.
 */

import * as fs from "fs";
import * as path from "path";
import type { ExtensionManifest } from "@mcp-moira/workflow-engine/extensions/contract";
import { validateExtensionManifest } from "@mcp-moira/workflow-engine/extensions";

export const MANIFEST_FILE = "moira-extension.json";

export interface LoadedBundle {
  /** Directory of the bundle inside the extensions directory. */
  directory: string;
  /** Absolute path of the entrypoint the handler process will import. */
  entrypoint: string;
  manifest: ExtensionManifest;
}

export interface RejectedBundle {
  directory: string;
  reasons: string[];
}

export interface BundleScanResult {
  bundles: LoadedBundle[];
  rejected: RejectedBundle[];
}

function readManifest(manifestPath: string): { manifest?: ExtensionManifest; reason?: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { reason: `${MANIFEST_FILE} must contain a JSON object` };
    }
    return { manifest: parsed as ExtensionManifest };
  } catch (error) {
    return {
      reason: `${MANIFEST_FILE} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Checks this process must make itself before it agrees to host a bundle. Moira validates
 * declarations again when it registers them; the point here is to refuse hosting a bundle whose
 * contract version, entrypoint or node names this runner cannot honour, and to say why.
 */
function checkManifest(manifest: ExtensionManifest, directory: string): string[] {
  const reasons = validateExtensionManifest(manifest)?.reasons ?? [];

  if (typeof manifest.entrypoint !== "string" || manifest.entrypoint.length === 0) {
    // The shared manifest validator already reports this shape. Resolution below is specific to
    // the runner because only this process owns the mounted bundle directory.
  } else {
    const resolved = path.resolve(directory, manifest.entrypoint);
    if (!resolved.startsWith(path.resolve(directory) + path.sep)) {
      reasons.push("manifest 'entrypoint' must stay inside the bundle directory");
    } else if (!fs.existsSync(resolved)) {
      reasons.push(`entrypoint '${manifest.entrypoint}' does not exist`);
    } else {
      try {
        const canonicalRoot = fs.realpathSync(directory);
        const canonicalEntrypoint = fs.realpathSync(resolved);
        const relative = path.relative(canonicalRoot, canonicalEntrypoint);
        if (
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          reasons.push(
            "manifest 'entrypoint' must not resolve through a symlink outside the bundle directory",
          );
        }
      } catch (error) {
        reasons.push(
          `entrypoint '${manifest.entrypoint}' could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return reasons;
}

/**
 * Read every bundle directory. A rejected bundle never prevents the others from loading: one
 * broken extension must not deny the installation the ones that are fine.
 */
export function scanExtensionBundles(extensionsDir: string): BundleScanResult {
  const bundles: LoadedBundle[] = [];
  const rejected: RejectedBundle[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch {
    // A missing or unreadable directory is the ordinary "no extensions installed" state.
    return { bundles, rejected };
  }

  const claimedTypes = new Map<string, string>();
  const claimedCommunicationChannels = new Map<string, string>();
  const claimedNames = new Map<string, string>();
  const claimedSettingKeys = new Map<string, string>();

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(extensionsDir, entry.name);
    const manifestPath = path.join(directory, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) continue;

    const { manifest, reason } = readManifest(manifestPath);
    if (!manifest) {
      rejected.push({ directory, reasons: [reason ?? "unreadable manifest"] });
      continue;
    }

    const reasons = checkManifest(manifest, directory);

    const previousName = claimedNames.get(manifest.name);
    if (previousName) {
      reasons.push(`extension name '${manifest.name}' is already provided by '${previousName}'`);
    }
    for (const node of Array.isArray(manifest.nodes) ? manifest.nodes : []) {
      const owner = claimedTypes.get(node?.type ?? "");
      if (owner) {
        // Both claimants are named: an operator has to know which bundle to remove.
        reasons.push(`node type '${node.type}' is already provided by '${owner}'`);
      }
    }
    for (const channel of Array.isArray(manifest.communicationChannels)
      ? manifest.communicationChannels
      : []) {
      const owner = claimedCommunicationChannels.get(channel?.id ?? "");
      if (owner) {
        reasons.push(`communication channel '${channel.id}' is already provided by '${owner}'`);
      }
    }

    for (const setting of Array.isArray(manifest.settings) ? manifest.settings : []) {
      const owner = claimedSettingKeys.get(setting?.key ?? "");
      if (owner) {
        // A settings key collides as badly as a node type: two extensions would read and overwrite
        // one stored value, so both claimants are named and the second bundle is refused.
        reasons.push(`setting key '${setting.key}' is already provided by '${owner}'`);
      }
    }

    if (reasons.length > 0) {
      rejected.push({ directory, reasons });
      continue;
    }

    claimedNames.set(manifest.name, directory);
    for (const node of manifest.nodes) claimedTypes.set(node.type, directory);
    for (const channel of manifest.communicationChannels ?? []) {
      claimedCommunicationChannels.set(channel.id, directory);
    }
    for (const setting of manifest.settings ?? []) claimedSettingKeys.set(setting.key, directory);

    bundles.push({
      directory,
      entrypoint: path.resolve(directory, manifest.entrypoint),
      manifest,
    });
  }

  return { bundles, rejected };
}
