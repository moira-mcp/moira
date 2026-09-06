/**
 * Extension registry: the single source of truth about custom node types inside Moira.
 *
 * It holds metadata and JSON Schemas received from the extension runner. It never holds,
 * imports or executes extension code, and it has no knowledge of how the runner is reached.
 */

import {
  EXTENSION_API_VERSION,
  ExtensionManifest,
  ExtensionManifestRejection,
  ExtensionNodeDeclaration,
  ExtensionPermissions,
  ExtensionRegistrySnapshot,
  ExtensionSettingDeclaration,
  RegisteredExtensionNode,
  RESERVED_SETTING_NAMESPACES,
  isExtensionNodeType,
  settingNamespaceOf,
} from "./extension-contract.js";
import { declaredSchemaProblem } from "./declared-schema.js";
import { prepareExtensionSettingValue } from "./extension-setting-values.js";

const MAX_NAME_LENGTH = 64;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

/** Keys this manifest declares as settings; a grant may only name one of them. */
function declaredSettingKeys(manifest: Partial<ExtensionManifest>): Set<string> {
  const keys = new Set<string>();
  for (const setting of Array.isArray(manifest.settings) ? manifest.settings : []) {
    if (setting && typeof setting.key === "string") keys.add(setting.key);
  }
  return keys;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNetworkHost(value: string): boolean {
  if (value.length === 0 || value.trim() !== value || value.includes("*")) return false;
  try {
    const parsed = new URL(`http://${value}`);
    return (
      parsed.host.length > 0 &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

/**
 * Add a reason when a declared schema is an object but not a schema Moira can compile.
 *
 * The check belongs here because this is the boundary that already answers "is this manifest
 * acceptable": a schema that only fails later turns a defect of the bundle into an exception inside
 * whatever consumer compiled it first.
 */
function collectSchemaProblem(reasons: string[], where: string, schema: unknown): void {
  const problem = declaredSchemaProblem(schema);
  if (problem) reasons.push(`${where} is not a usable JSON Schema: ${problem}`);
}

/** Collect every reason a manifest is unacceptable. An invalid manifest is rejected whole. */
export function validateExtensionManifest(candidate: unknown): ExtensionManifestRejection | null {
  const reasons: string[] = [];

  if (!isPlainObject(candidate)) {
    return { reasons: ["Manifest must be an object"] };
  }

  const manifest = candidate as Partial<ExtensionManifest>;

  if (manifest.apiVersion !== EXTENSION_API_VERSION) {
    reasons.push(
      `Unsupported apiVersion '${String(manifest.apiVersion)}'; this Moira build understands '${EXTENSION_API_VERSION}'`,
    );
  }

  if (typeof manifest.name !== "string" || !NAME_PATTERN.test(manifest.name)) {
    reasons.push(
      "Manifest 'name' must be lowercase letters, digits and hyphens, starting with a letter or digit",
    );
  } else if (manifest.name.length > MAX_NAME_LENGTH) {
    reasons.push(`Manifest 'name' must be at most ${MAX_NAME_LENGTH} characters`);
  }

  if (typeof manifest.version !== "string" || !SEMVER_PATTERN.test(manifest.version)) {
    reasons.push("Manifest 'version' must be a semantic version such as '1.0.0'");
  }

  if (typeof manifest.entrypoint !== "string" || manifest.entrypoint.length === 0) {
    reasons.push("Manifest 'entrypoint' must be a non-empty string");
  }

  if (!Array.isArray(manifest.nodes) || manifest.nodes.length === 0) {
    reasons.push("Manifest 'nodes' must declare at least one node type");
  } else {
    const seen = new Set<string>();
    manifest.nodes.forEach((node, index) => {
      const where = `nodes[${index}]`;
      if (!isPlainObject(node)) {
        reasons.push(`${where} must be an object`);
        return;
      }
      const declaration = node as Partial<ExtensionNodeDeclaration>;
      if (typeof declaration.type !== "string" || !isExtensionNodeType(declaration.type)) {
        reasons.push(
          `${where}.type must be namespaced as '<extension>.<node>' using lowercase letters, digits and hyphens`,
        );
      } else {
        if (
          typeof manifest.name === "string" &&
          !declaration.type.startsWith(`${manifest.name}.`)
        ) {
          reasons.push(
            `${where}.type '${declaration.type}' must start with the extension name '${manifest.name}.'`,
          );
        }
        if (seen.has(declaration.type)) {
          reasons.push(`${where}.type '${declaration.type}' is declared twice in this manifest`);
        }
        seen.add(declaration.type);
      }
      if (typeof declaration.title !== "string" || declaration.title.length === 0) {
        reasons.push(`${where}.title must be a non-empty string`);
      }
      if (declaration.description !== undefined && typeof declaration.description !== "string") {
        reasons.push(`${where}.description must be a string when present`);
      }
      if (!isPlainObject(declaration.configSchema)) {
        reasons.push(`${where}.configSchema must be a JSON Schema object`);
      } else {
        collectSchemaProblem(reasons, `${where}.configSchema`, declaration.configSchema);
      }
      if (!isPlainObject(declaration.outputSchema)) {
        reasons.push(`${where}.outputSchema must be a JSON Schema object`);
      } else {
        collectSchemaProblem(reasons, `${where}.outputSchema`, declaration.outputSchema);
      }
      if (declaration.inputSchema !== undefined) {
        if (!isPlainObject(declaration.inputSchema)) {
          reasons.push(`${where}.inputSchema must be a JSON Schema object when present`);
        } else {
          collectSchemaProblem(reasons, `${where}.inputSchema`, declaration.inputSchema);
        }
      }
    });
  }

  if (
    typeof manifest.name === "string" &&
    (RESERVED_SETTING_NAMESPACES as readonly string[]).includes(manifest.name)
  ) {
    // The extension name *is* its settings namespace, so an extension called `telegram` owns
    // `telegram.*` by construction — including Moira's own keys. Checking the name itself is the
    // only place that holds for a manifest which declares no settings at all and simply asks for
    // one in `permissions.secrets`.
    reasons.push(
      `Manifest 'name' '${manifest.name}' is a namespace Moira uses for its own settings`,
    );
  }

  if (manifest.settings !== undefined) {
    if (!Array.isArray(manifest.settings)) {
      reasons.push("Manifest 'settings' must be an array when present");
    } else {
      const seenSettings = new Set<string>();
      manifest.settings.forEach((setting, index) => {
        const where = `settings[${index}]`;
        if (!isPlainObject(setting)) {
          reasons.push(`${where} must be an object`);
          return;
        }
        const declaration = setting as Partial<ExtensionSettingDeclaration>;
        if (typeof declaration.key !== "string" || declaration.key.length === 0) {
          reasons.push(`${where}.key must be a non-empty string`);
        } else {
          if (seenSettings.has(declaration.key)) {
            reasons.push(`${where}.key '${declaration.key}' is declared twice in this manifest`);
          }
          seenSettings.add(declaration.key);
          if (
            typeof manifest.name === "string" &&
            !declaration.key.startsWith(`${manifest.name}.`)
          ) {
            reasons.push(
              `${where}.key '${declaration.key}' must live in the extension namespace '${manifest.name}.'`,
            );
          } else if (
            (RESERVED_SETTING_NAMESPACES as readonly string[]).includes(
              settingNamespaceOf(declaration.key),
            )
          ) {
            // The namespace belongs to Moira itself. Without this the extension would shadow a
            // built-in setting: its declaration is merged into the same list, and the database can
            // no longer refuse the duplicate because the declaration never reaches it.
            reasons.push(
              `${where}.key '${declaration.key}' uses the reserved namespace '${settingNamespaceOf(declaration.key)}'`,
            );
          }
        }
        const allowedTypes = ["string", "number", "boolean", "json", "encrypted"] as const;
        const hasValidType =
          typeof declaration.type === "string" &&
          (allowedTypes as readonly string[]).includes(declaration.type);
        if (!hasValidType) {
          reasons.push(`${where}.type must be one of ${allowedTypes.join(", ")}`);
        }
        if (typeof declaration.label !== "string" || declaration.label.length === 0) {
          reasons.push(`${where}.label must be a non-empty string`);
        }
        if (declaration.description !== undefined && typeof declaration.description !== "string") {
          reasons.push(`${where}.description must be a string when present`);
        }
        if (
          declaration.defaultValue !== undefined &&
          typeof declaration.defaultValue !== "string"
        ) {
          reasons.push(`${where}.defaultValue must be a string when present`);
        }
        if (declaration.required !== undefined && typeof declaration.required !== "boolean") {
          reasons.push(`${where}.required must be a boolean when present`);
        }
        if (declaration.adminOnly !== undefined && typeof declaration.adminOnly !== "boolean") {
          reasons.push(`${where}.adminOnly must be a boolean when present`);
        }
        if (declaration.validation !== undefined) {
          if (!isPlainObject(declaration.validation)) {
            reasons.push(`${where}.validation must be a JSON Schema object when present`);
          } else {
            collectSchemaProblem(reasons, `${where}.validation`, declaration.validation);
          }
        }
        if (
          declaration.defaultValue !== undefined &&
          typeof declaration.defaultValue === "string" &&
          hasValidType &&
          (declaration.validation === undefined || isPlainObject(declaration.validation))
        ) {
          const prepared = prepareExtensionSettingValue(
            {
              key: typeof declaration.key === "string" ? declaration.key : `${where}.defaultValue`,
              type: declaration.type as ExtensionSettingDeclaration["type"],
              validation: declaration.validation,
            },
            declaration.defaultValue,
          );
          if (prepared.problem) {
            reasons.push(`${where}.defaultValue ${prepared.problem}`);
          }
        }
      });
    }
  }

  if (manifest.permissions !== undefined) {
    if (!isPlainObject(manifest.permissions)) {
      reasons.push("Manifest 'permissions' must be an object when present");
    } else {
      const permissions = manifest.permissions as Partial<ExtensionPermissions>;
      if (permissions.network !== undefined) {
        if (!Array.isArray(permissions.network)) {
          reasons.push("Manifest 'permissions.network' must be an array when present");
        } else {
          for (const host of permissions.network) {
            if (typeof host !== "string" || host.length === 0) {
              reasons.push("permissions.network entries must be non-empty strings");
            } else if (!isNetworkHost(host)) {
              reasons.push(
                `permissions.network entry '${host}' must be host names without a scheme, path, credentials, query, fragment or wildcard`,
              );
            }
          }
        }
      }
      if (permissions.secrets !== undefined) {
        if (!Array.isArray(permissions.secrets)) {
          reasons.push("Manifest 'permissions.secrets' must be an array when present");
        } else {
          const seenAliases = new Set<string>();
          for (const alias of permissions.secrets) {
            // A grant is a request for a value, and the namespace rule has to hold for the request as
            // well as for the declaration: without this an extension could ask for `telegram.bot_token`
            // and be handed Moira's own secret, or for a key belonging to another extension.
            if (typeof alias !== "string" || alias.length === 0) {
              reasons.push("permissions.secrets entries must be non-empty strings");
            } else if (seenAliases.has(alias)) {
              reasons.push(`permissions.secrets entry '${alias}' is declared twice`);
            } else if (
              typeof manifest.name === "string" &&
              !alias.startsWith(`${manifest.name}.`)
            ) {
              reasons.push(
                `permissions.secrets entry '${alias}' must live in the extension namespace '${manifest.name}.'`,
              );
            } else if (!declaredSettingKeys(manifest).has(alias)) {
              // A grant names a setting, so that setting has to be declared in this manifest. Without
              // this the bundle loads and the refusal happens later, when a value is read — where it
              // looks to the handler exactly like a setting nobody has filled in.
              reasons.push(
                `permissions.secrets entry '${alias}' is not declared in this manifest's settings`,
              );
            }
            if (typeof alias === "string") seenAliases.add(alias);
          }
        }
      }
      if (permissions.artifacts !== undefined && typeof permissions.artifacts !== "boolean") {
        reasons.push("Manifest 'permissions.artifacts' must be a boolean when present");
      }
    }
  }

  if (reasons.length === 0) return null;
  return {
    manifestName: typeof manifest.name === "string" ? manifest.name : undefined,
    reasons,
  };
}

/** Outcome of registering one manifest. */
/** Where a registry's knowledge comes from; see `ExtensionRegistry.origin`. */
export type ExtensionRegistryOrigin = "live" | "snapshot" | "unconfigured" | "unreachable";

export interface ExtensionRegistrationResult {
  registered: boolean;
  rejection?: ExtensionManifestRejection;
}

export class ExtensionRegistry {
  private nodesByType = new Map<string, RegisteredExtensionNode>();
  private manifestsByName = new Map<string, ExtensionManifest>();

  private knowledgeSource: ExtensionRegistryOrigin;

  /**
   * Where this registry's knowledge comes from, and therefore what its emptiness means.
   *
   * `live` — an extension service answered this process, so a type the registry lacks is a type this
   * installation does not have. `snapshot` — rebuilt from a published file that may predate or
   * postdate the installation it describes. `unconfigured` — no service is configured here at all.
   * `unreachable` — a service is configured but has not answered, so the registry is empty for a
   * reason that says nothing about what is installed. Only the first licenses the sentence "this
   * extension is not installed"; the rest mean "this copy cannot tell", and they must stay
   * distinguishable because consumers report them to a person differently.
   */
  get origin(): ExtensionRegistryOrigin {
    return this.knowledgeSource;
  }

  constructor(origin: ExtensionRegistryOrigin = "live") {
    this.knowledgeSource = origin;
  }

  /**
   * Record what became known about the source after the registry was created.
   *
   * A registry is created before its service is asked — consumers take the object once and must not
   * be handed a different one later — so the answer arrives after construction: the service replied
   * (`live`) or it did not. Nothing else may move a registry between sources.
   */
  noteKnowledgeSource(origin: ExtensionRegistryOrigin): void {
    this.knowledgeSource = origin;
  }

  /**
   * Accept a manifest whole or reject it whole. A type already owned by another extension is a
   * conflict: both owners are named, and nothing from the conflicting manifest is registered.
   */
  register(candidate: unknown): ExtensionRegistrationResult {
    const rejection = validateExtensionManifest(candidate);
    if (rejection) {
      return { registered: false, rejection };
    }

    const manifest = candidate as ExtensionManifest;
    const reasons: string[] = [];

    if (this.manifestsByName.has(manifest.name)) {
      reasons.push(`Extension '${manifest.name}' is already registered`);
    }

    for (const declaration of manifest.nodes) {
      const existing = this.nodesByType.get(declaration.type);
      if (existing && existing.extensionName !== manifest.name) {
        reasons.push(
          `Node type '${declaration.type}' is already declared by extension '${existing.extensionName}'`,
        );
      }
    }

    if (reasons.length > 0) {
      return { registered: false, rejection: { manifestName: manifest.name, reasons } };
    }

    const permissions: ExtensionPermissions = manifest.permissions ?? {};
    for (const declaration of manifest.nodes) {
      this.nodesByType.set(declaration.type, {
        extensionName: manifest.name,
        extensionVersion: manifest.version,
        declaration,
        permissions,
      });
    }
    this.manifestsByName.set(manifest.name, manifest);

    return { registered: true };
  }

  /**
   * Replace the whole content of this registry in place.
   *
   * Mutating rather than returning a new registry matters: consumers — the graph executor in
   * particular — take the registry object once when they are built, so swapping the object would
   * leave them looking at the state the process had at start-up.
   */
  replaceAll(manifests: unknown[]): {
    registered: string[];
    rejected: ExtensionManifestRejection[];
  } {
    this.nodesByType.clear();
    this.manifestsByName.clear();

    const registered: string[] = [];
    const rejected: ExtensionManifestRejection[] = [];
    for (const candidate of manifests) {
      const result = this.register(candidate);
      if (result.registered) {
        registered.push((candidate as ExtensionManifest).name);
      } else if (result.rejection) {
        rejected.push(result.rejection);
      }
    }
    return { registered, rejected };
  }

  /** Remove an extension and every type it owns; values stored elsewhere are untouched. */
  unregister(extensionName: string): boolean {
    if (!this.manifestsByName.delete(extensionName)) return false;
    for (const [type, node] of this.nodesByType) {
      if (node.extensionName === extensionName) this.nodesByType.delete(type);
    }
    return true;
  }

  has(nodeType: string): boolean {
    return this.nodesByType.has(nodeType);
  }

  get(nodeType: string): RegisteredExtensionNode | undefined {
    return this.nodesByType.get(nodeType);
  }

  nodeTypes(): string[] {
    return [...this.nodesByType.keys()].sort();
  }

  manifests(): ExtensionManifest[] {
    return [...this.manifestsByName.values()];
  }

  /** Settings declared by all registered extensions, in registration order. */
  settingDeclarations(): Array<{
    extensionName: string;
    declaration: ExtensionSettingDeclaration;
  }> {
    const result: Array<{ extensionName: string; declaration: ExtensionSettingDeclaration }> = [];
    for (const manifest of this.manifestsByName.values()) {
      for (const declaration of manifest.settings ?? []) {
        result.push({ extensionName: manifest.name, declaration });
      }
    }
    return result;
  }

  /** Projection for consumers that cannot query the registry directly (for example the CLI). */
  snapshot(now: Date = new Date()): ExtensionRegistrySnapshot {
    return {
      apiVersion: EXTENSION_API_VERSION,
      generatedAt: now.toISOString(),
      extensions: [...this.manifestsByName.values()].map((manifest) => ({
        name: manifest.name,
        version: manifest.version,
        nodes: manifest.nodes,
      })),
    };
  }
}
