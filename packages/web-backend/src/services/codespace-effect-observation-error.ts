import { CodespaceResourceError, codespaceObservationErrorCode } from "@mcp-moira/shared";

/** The owner confirmed its effect; only projecting its captured observation failed. */
export class CodespaceEffectObservationError extends CodespaceResourceError {
  constructor(error: unknown) {
    super(
      codespaceObservationErrorCode(error),
      "The confirmed effect has no available workspace observation.",
    );
    this.name = "CodespaceEffectObservationError";
  }
}
