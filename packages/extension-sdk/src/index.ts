/**
 * Authoring SDK for Moira extension nodes.
 *
 * An extension declares node types and implements their handlers against this contract. The SDK is
 * deliberately thin: it fixes the shape of a declaration and the services a handler may use, and it
 * adds no runtime of its own. Everything a handler can reach is passed to it — there is no ambient
 * access to Moira, its database, its configuration or its file system, because the handler runs in a
 * different process from the application.
 */

/** JSON-serialisable value: what may cross the boundary between Moira and an extension. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Services granted to a handler. Anything not granted by the manifest is refused, not silent. */
export interface ExtensionNodeServices {
  /**
   * Structured log line. Values are recorded by the runner; secret values obtained through
   * `secrets` must not be passed here — the runner does not scan for them.
   */
  log(message: string, fields?: JsonObject): void;

  /**
   * Outgoing HTTP request. Only hosts granted by the manifest's `permissions.network` are allowed;
   * anything else is refused with a named error rather than attempted.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;

  /**
   * Value of a setting the manifest asked for by alias in `permissions.secrets`. An alias that was
   * not granted is refused with a named error, which is distinguishable from an unset value (that
   * returns null).
   */
  secret(alias: string): Promise<string | null>;

  /**
   * Attach an artifact payload to this node's result. Requires `permissions.artifacts`; refused by
   * name otherwise. The payload returns with the call result under the node-scoped `artifacts`
   * field; it is not published through Moira's HTML ArtifactService. Its size is bounded by the
   * runner, and exceeding the bound fails the whole call rather than returning a partial payload.
   */
  writeArtifact(name: string, content: string): Promise<void>;
}

/** Everything a handler is given for one invocation. */
export interface ExtensionNodeContext<
  Config extends JsonObject = JsonObject,
  Input extends JsonObject = JsonObject,
> {
  /**
   * Node configuration after Moira substituted its templates and checked the result against the
   * declared configSchema. A configuration that does not match never reaches the handler.
   */
  config: Config;
  /** Values mapped into this call, substituted and checked against the declared inputSchema. */
  input: Input;
  /** Identifiers of the execution and node this call belongs to; no other execution state. */
  executionId: string;
  nodeId: string;
  /** Aborted when the call exceeds its deadline or Moira cancels it. */
  signal: AbortSignal;
  services: ExtensionNodeServices;
}

export type ExtensionNodeHandler<
  Config extends JsonObject = JsonObject,
  Input extends JsonObject = JsonObject,
  Output extends JsonObject = JsonObject,
> = (context: ExtensionNodeContext<Config, Input>) => Promise<Output>;

/**
 * One node type an extension contributes.
 *
 * The manifest is the single source of truth for what a node declares: Moira reads schemas from
 * there, and so does the runner. Restating a schema here is optional and exists for authors who
 * prefer to keep it beside the handler; when it is present the runner compares it with the manifest
 * and refuses to host the bundle if the two disagree, because a silent disagreement would leave the
 * author reading one schema while the system enforces another.
 */
export interface ExtensionNodeDefinition<
  Config extends JsonObject = JsonObject,
  Input extends JsonObject = JsonObject,
  Output extends JsonObject = JsonObject,
> {
  /** Namespaced type, `<extension>.<node>`; must match the manifest. */
  type: string;
  title?: string;
  description?: string;
  /** Optional restatement of the manifest's schema; checked against it at load. */
  configSchema?: JsonObject;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  handler: ExtensionNodeHandler<Config, Input, Output>;
}

export interface ExtensionCommunicationAttachment {
  kind: "image" | "document";
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface ExtensionCommunicationMessage {
  text: string;
  format?: "plain" | "markdown" | "html";
  silent?: boolean;
  attachment?: ExtensionCommunicationAttachment;
}

/** Services granted specifically to one channel declaration. */
export interface ExtensionCommunicationServices {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  secret(alias: string): Promise<string | null>;
}

export interface ExtensionCommunicationChannelContext<Settings extends JsonObject = JsonObject> {
  message: ExtensionCommunicationMessage;
  settings: Settings;
  signal: AbortSignal;
  services: ExtensionCommunicationServices;
}

export type ExtensionCommunicationChannelHandler<Settings extends JsonObject = JsonObject> = (
  context: ExtensionCommunicationChannelContext<Settings>,
) => Promise<void>;

export interface ExtensionCommunicationChannelDefinition<Settings extends JsonObject = JsonObject> {
  id: string;
  configurationSchema?: JsonObject;
  handler: ExtensionCommunicationChannelHandler<Settings>;
}

/** Declare an outbound communication channel without registering or executing it in-process. */
export function defineChannel<Settings extends JsonObject = JsonObject>(
  definition: ExtensionCommunicationChannelDefinition<Settings>,
): ExtensionCommunicationChannelDefinition<Settings> {
  return definition;
}

/**
 * Declare a node type. The function exists so that authoring is typed and so that a bundle exports
 * a recognisable shape; it performs no registration and has no side effects.
 */
export function defineNode<
  Config extends JsonObject = JsonObject,
  Input extends JsonObject = JsonObject,
  Output extends JsonObject = JsonObject,
>(
  definition: ExtensionNodeDefinition<Config, Input, Output>,
): ExtensionNodeDefinition<Config, Input, Output> {
  return definition;
}

/** What a bundle's entrypoint must export as its default value. */
export interface ExtensionModule {
  nodes?: ExtensionNodeDefinition[];
  communicationChannels?: ExtensionCommunicationChannelDefinition[];
}

/** Declare the bundle's set of node types. */
export function defineExtension(module: ExtensionModule): ExtensionModule {
  return module;
}
