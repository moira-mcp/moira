/**
 * Boundary between Moira and extension code.
 *
 * Everything an extension does happens behind this interface: a serialisable request goes out,
 * a serialisable result comes back. Moira holds no reference to extension objects, so an
 * implementation that imported a handler into this process would violate the contract even if
 * its return values looked identical.
 *
 * The transport implementation (the separate runner service) is not part of this unit.
 */

export interface ExtensionInvocationRequest {
  /** Namespaced node type being executed. */
  nodeType: string;
  /** Node id inside the workflow graph — the scope its result is stored under. */
  nodeId: string;
  executionId: string;
  workflowId: string;
  /** Authoring-time configuration of the node, already template-processed. */
  config: Record<string, unknown>;
  /** Values mapped into the call; absent when the node declares no input. */
  input?: Record<string, unknown>;
  /** Milliseconds after which the call must be aborted, not merely stopped being awaited. */
  timeoutMs: number;
  /**
   * Values of the settings the extension's manifest asked for by alias in `permissions.secrets`,
   * resolved for the user this execution belongs to. Only granted aliases appear; an alias with no
   * value appears as `null`, which the handler sees as "not set" — distinct from the named refusal
   * it gets for an alias it never asked for.
   */
  secrets?: Record<string, string | null>;
}

/** How an invocation failed or was refused; every cause routes to `error` with its own diagnostic. */
export type ExtensionFailureKind =
  | "handler-error"
  | "timeout"
  | "runner-unavailable"
  | "invalid-output"
  /**
   * The call was refused before it was made: the node's configuration or input did not match the
   * schema the extension declared. It is a class of its own because nothing failed on the far side
   * — reporting it as a handler failure would send an author looking at the extension instead of at
   * their own node. The runner never produces it.
   */
  | "invalid-input";

export class ExtensionInvocationError extends Error {
  constructor(
    readonly kind: ExtensionFailureKind,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ExtensionInvocationError";
  }
}

export interface ExtensionInvocationResult {
  /** Handler output; validated against the declared outputSchema before it reaches the context. */
  output: Record<string, unknown>;
  /**
   * Artifacts the handler wrote during this call. They arrive with the result rather than through
   * a channel of their own, so a call that failed cannot leave one behind.
   */
  artifacts?: Array<{ name: string; content: string }>;
}

export interface ExtensionCommunicationChannelRequest {
  channelId: string;
  timeoutMs: number;
  message: {
    text: string;
    format?: "plain" | "markdown" | "html";
    silent?: boolean;
    attachment?: {
      kind: "image" | "document";
      bytes: Uint8Array;
      filename: string;
      mimeType: string;
    };
  };
  settings?: Record<string, unknown>;
  secrets?: Record<string, string | null>;
}

export interface IExtensionRunnerClient {
  /**
   * Execute one custom node out-of-process.
   * Implementations reject with ExtensionInvocationError; any other rejection is normalised by
   * the caller into `handler-error`.
   */
  invoke(request: ExtensionInvocationRequest): Promise<ExtensionInvocationResult>;
  /** Optional only so node-only test clients remain source-compatible; channel adapters refuse it. */
  checkCommunicationChannel?(
    channelId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void>;
  deliverCommunicationChannel?(
    request: ExtensionCommunicationChannelRequest,
    signal?: AbortSignal,
  ): Promise<void>;
}
