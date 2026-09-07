/**
 * Extension contract: what an extension declares and what Moira accepts from it.
 *
 * Moira never loads extension code. An extension is described by a manifest whose node
 * declarations carry JSON Schemas; execution happens out-of-process behind
 * IExtensionRunnerClient. Everything in this file is data, not behaviour.
 */

/** Contract version understood by this build. A manifest declaring anything else is rejected. */
export const EXTENSION_API_VERSION = "moira.extensions/v1";

/** Wire protocol version spoken between Moira and the isolated extension runner. */
export const EXTENSION_RUNNER_API_VERSION = "moira.extension-runner/v2";

/**
 * Namespaced custom node type: `<extension>.<node>`.
 * The dot is what keeps custom types disjoint from every built-in type (none contain a dot),
 * so the graph schema stays discriminating instead of becoming permissive.
 */
export const EXTENSION_NODE_TYPE_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

/** True when the string is shaped like a custom node type, regardless of registration. */
export function isExtensionNodeType(type: string): boolean {
  return EXTENSION_NODE_TYPE_PATTERN.test(type);
}

/** Extension name carried by a custom node type, or null when the type is not namespaced. */
export function extensionNameOf(type: string): string | null {
  if (!isExtensionNodeType(type)) return null;
  return type.slice(0, type.indexOf("."));
}

/** One node type declared by an extension. */
export interface ExtensionNodeDeclaration {
  /** Namespaced type, e.g. `corporate-messenger.send`. */
  type: string;
  /** Human-readable title for editors and listings. */
  title: string;
  description?: string;
  /** JSON Schema of the node's authoring-time configuration. */
  configSchema: Record<string, unknown>;
  /** JSON Schema of the values passed into the handler at execution time. */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema the handler result must satisfy; a violating result routes to `error`. */
  outputSchema: Record<string, unknown>;
}

/**
 * Namespaces Moira's own settings use.
 *
 * An extension's settings live in its own namespace, and the extension name is that namespace — so
 * an extension called `telegram` would be free to declare `telegram.bot_token`. Nothing else would
 * catch it: the database used to guarantee uniqueness through its primary key, and an extension's
 * definitions never reach the database. Hence a list, checked when the extension is registered.
 *
 * A built-in setting introduced in a new namespace must be added here; a test compares this list
 * against the definitions the installation seeds, so the omission surfaces where it is made rather
 * than as an extension quietly shadowing a built-in setting.
 */
export const RESERVED_SETTING_NAMESPACES = [
  "telegram",
  "ui",
  "profile",
  "mcp",
  "artifacts",
  "notes",
  "executions",
] as const;

/** The namespace of a setting key — the part before the first dot. */
export function settingNamespaceOf(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(0, dot);
}

/** A setting an extension declares. Definitions stay in the manifest and never enter the database. */
export interface ExtensionSettingDeclaration {
  key: string;
  type: "string" | "number" | "boolean" | "json" | "encrypted";
  label: string;
  description?: string;
  defaultValue?: string;
  required?: boolean;
  adminOnly?: boolean;
  /** JSON Schema applied to the value. */
  validation?: Record<string, unknown>;
}

/** Capabilities an extension asks for; anything not requested is denied at call time. */
export interface ExtensionPermissions {
  /** Hosts the handler may contact. */
  network?: string[];
  /** Setting keys whose values may be substituted into the call as secret aliases. */
  secrets?: string[];
  /** Whether the handler may write execution artifacts. */
  artifacts?: boolean;
}

export interface ExtensionCommunicationChannelCapabilities {
  text: boolean;
  image: boolean;
  document: boolean;
  /** Declaration only. Effective trusted eligibility also requires independent admin approval. */
  trustedDelivery?: boolean;
}

/** Permissions scoped to one communication handler rather than every contribution in the bundle. */
export interface ExtensionCommunicationChannelPermissions {
  network?: string[];
  secrets?: string[];
}

/** One ordinary outbound communication channel contributed by an extension. */
export interface ExtensionCommunicationChannelDeclaration {
  /** Stable namespaced identity, for example `corporate-messenger.notifications`. */
  id: string;
  title: string;
  description?: string;
  capabilities: ExtensionCommunicationChannelCapabilities;
  /** Schema applied to the object formed from the exact non-secret setting aliases below. */
  configurationSchema: Record<string, unknown>;
  /** Declared boolean setting whose false value disables ordinary delivery for this user. */
  enabledSetting: string;
  /** Manifest-declared setting aliases passed as ordinary JSON configuration. */
  settings?: string[];
  /** Network and secret grants used only while this channel handler runs. */
  permissions?: ExtensionCommunicationChannelPermissions;
}

export interface ExtensionManifest {
  apiVersion: string;
  name: string;
  version: string;
  /** Entrypoint resolved by the runner, never by Moira. */
  entrypoint: string;
  nodes: ExtensionNodeDeclaration[];
  communicationChannels?: ExtensionCommunicationChannelDeclaration[];
  settings?: ExtensionSettingDeclaration[];
  permissions?: ExtensionPermissions;
}

/** Why a manifest was rejected. A manifest is accepted whole or not at all. */
export interface ExtensionManifestRejection {
  manifestName?: string;
  reasons: string[];
}

/** Registered node type together with the extension that owns it. */
export interface RegisteredExtensionNode {
  extensionName: string;
  extensionVersion: string;
  declaration: ExtensionNodeDeclaration;
  permissions: ExtensionPermissions;
}

/** Registered communication channel together with the manifest data needed to configure it. */
export interface RegisteredExtensionCommunicationChannel {
  extensionName: string;
  extensionVersion: string;
  declaration: ExtensionCommunicationChannelDeclaration;
  settingDeclarations: ExtensionSettingDeclaration[];
}

/** Serialisable projection of the registry: what registry-less consumers read from a snapshot. */
export interface ExtensionRegistrySnapshot {
  apiVersion: string;
  generatedAt: string;
  extensions: Array<{
    name: string;
    version: string;
    /** Data-only declarations required to validate configuration outside the live process. */
    nodes: ExtensionNodeDeclaration[];
    communicationChannels?: ExtensionCommunicationChannelDeclaration[];
    /** Definitions referenced by channel configuration; never per-user values. */
    settings?: ExtensionSettingDeclaration[];
  }>;
}
