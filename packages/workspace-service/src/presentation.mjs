import { scopedCredentialFailureOutcome } from "../../shared/src/codespaces/scoped-credential-types.ts";

export function workspaceResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    ...(data.error || data.outcome?.ok === false || data.state === "unconfirmed"
      ? { isError: true }
      : {}),
  };
}

/** Bounded owner errors preserve recovery references, never source input or credentials. */
export function workspaceFailure(error, requestId) {
  const fileReason =
    error?.fileReason ?? (["ELOOP", "ENOTDIR"].includes(error?.code) ? "unsafe_access" : undefined);
  const candidate = error?.details?.error ?? {
    code:
      error?.publicCode ??
      (error?.code === "ENOENT" ? "NOT_FOUND" : fileReason ? "FILE_REJECTED" : undefined),
    reason: fileReason,
  };
  const scopedOutcome = scopedCredentialFailureOutcome(candidate.code);
  const known =
    typeof candidate.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,79}$/.test(candidate.code) &&
    (!Number.isInteger(error.httpStatus) || error.httpStatus < 500 || scopedOutcome !== null);
  return workspaceResult({
    error: {
      code: known
        ? candidate.code
        : requestId || error.operation
          ? "WORKSPACE_OUTCOME_UNCONFIRMED"
          : "WORKSPACE_UNAVAILABLE",
      message:
        candidate.reason === "unsafe_access"
          ? "File access was refused. Use a path relative to the selected workspace repository, such as 'moira-ws/task/file.md', without absolute paths or '..'. File tools do not follow symlinks or accept unsupported file types. If an operation reference is returned, inspect that original before retrying a mutation."
          : scopedOutcome === "unconfirmed"
            ? "Scoped credential outcome is unconfirmed. Inspect the original operation."
            : error.operation
              ? "The owner could not complete this request. Inspect its original operation before another action."
              : "The workspace refused or could not observe this request.",
      ...(["unsafe_access", "concurrent_change", "precondition"].includes(candidate.reason)
        ? { reason: candidate.reason }
        : {}),
      ...(Number.isSafeInteger(error.minimum_bytes) ? { minimum_bytes: error.minimum_bytes } : {}),
    },
    ...(error.operation
      ? { operation: error.operation }
      : requestId
        ? { request_id: requestId }
        : {}),
    ...(error.securityOperation ? { security_operation: error.securityOperation } : {}),
  });
}

/** The same purpose-specific owner contract serves MCP, browser adapters and the guest CLI. */
export async function executeOwnerTool(owner, input, { signal, source } = {}) {
  try {
    if (
      !input ||
      typeof input.action !== "string" ||
      !input.request ||
      typeof input.request !== "object" ||
      Array.isArray(input.request)
    )
      throw Object.assign(new Error("INVALID_SEMANTIC_REQUEST"), {
        publicCode: "INVALID_SEMANTIC_REQUEST",
      });
    const result = await owner.semantic(input.action, input.request, {
      requestId: input.requestId,
      signal,
      source,
    });
    return Array.isArray(result?.content) ? result : workspaceResult(result);
  } catch (error) {
    return workspaceFailure(error);
  }
}
