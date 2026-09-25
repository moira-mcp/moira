/**
 * The one error the authoring functions throw. `code` is stable for callers that react to a
 * specific refusal (the browser editor maps it to a message, the CLI prints `message`); `message`
 * names the offending node, key or block so it can be shown as is.
 */
export type AuthoringErrorCode =
  | "node-not-found"
  | "node-exists"
  | "invalid-node-id"
  | "invalid-connection-key"
  | "connection-not-found"
  | "label-not-found"
  | "protected-output"
  | "terminal-node"
  | "only-start"
  | "duplicate-start"
  | "incoming-edge-undecided"
  | "invalid-target"
  | "block-required"
  | "block-not-found"
  | "block-exists"
  | "block-not-empty"
  | "no-progress"
  | "invalid-block"
  | "invalid-label";

export class AuthoringError extends Error {
  readonly code: AuthoringErrorCode;

  constructor(code: AuthoringErrorCode, message: string) {
    super(message);
    this.name = "AuthoringError";
    this.code = code;
  }
}
