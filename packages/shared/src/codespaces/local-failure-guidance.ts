import type { CodespaceResourceErrorCode } from "./resource-types.js";

/** Both public transports describe the same bounded local refusal; UI localizes its code. */
export const LOCAL_CODESPACE_FAILURE_GUIDANCE: Readonly<
  Record<
    Extract<CodespaceResourceErrorCode, `CODESPACE_LOCAL_${string}`>,
    {
      status: number;
      message: string;
    }
  >
> = Object.freeze({
  CODESPACE_LOCAL_CREATION_UNKNOWN: {
    status: 409,
    message:
      "The local computer cannot confirm creation of this codespace. Inspect this same retained codespace identity; do not create a replacement. The physical outcome is not confirmed.",
  },
  CODESPACE_LOCAL_SETUP_INCOMPLETE: {
    status: 409,
    message:
      "Guest preparation did not complete. Delete this codespace and confirm its removal before creating a replacement; restarting does not complete initial setup.",
  },
  CODESPACE_LOCAL_PROTOCOL_ERROR: {
    status: 409,
    message:
      "Moira and the local companion could not validate their protocol or saved state. Update the matching server and companion, then check this same codespace again. The physical outcome is not confirmed.",
  },
  CODESPACE_LOCAL_RUNTIME_ERROR: {
    status: 503,
    message:
      "The local VM runtime could not confirm this operation. Check the local computer's runtime diagnostics, then inspect this same codespace before retrying. The physical outcome is not confirmed.",
  },
  CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED: {
    status: 403,
    message:
      "Deletion is not approved for this repository on the local computer. Allow deletion in that computer's repository settings, wait for application, then confirm deletion of this same codespace.",
  },
});

export function localCodespaceFailureGuidance(code: string):
  | {
      status: number;
      message: string;
    }
  | undefined {
  return Object.hasOwn(LOCAL_CODESPACE_FAILURE_GUIDANCE, code)
    ? LOCAL_CODESPACE_FAILURE_GUIDANCE[code as keyof typeof LOCAL_CODESPACE_FAILURE_GUIDANCE]
    : undefined;
}
