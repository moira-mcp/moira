import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CodespaceResourceError,
  LocalDeviceError,
  localCodespaceFailureGuidance,
} from "@mcp-moira/shared";
import { CommunicationChannelOwnerUnavailableError } from "@mcp-moira/workflow-engine";

export function semanticResult(value: unknown, isError = false): CallToolResult {
  if (value && typeof value === "object" && "content" in value && Array.isArray(value.content))
    return value as CallToolResult;
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ||
    data.error ||
    data.state === "unconfirmed" ||
    (data.outcome &&
      typeof data.outcome === "object" &&
      "ok" in data.outcome &&
      data.outcome.ok === false)
      ? { isError: true }
      : {}),
  };
}

function finiteCode(error: unknown): string | undefined {
  if (
    error instanceof CodespaceResourceError ||
    error instanceof LocalDeviceError ||
    error instanceof CommunicationChannelOwnerUnavailableError
  )
    return error.code;
  if (!error || typeof error !== "object" || !("details" in error)) return;
  const details = error.details;
  if (!details || typeof details !== "object" || !("error" in details)) return;
  const refusal = details.error;
  if (
    refusal &&
    typeof refusal === "object" &&
    "code" in refusal &&
    typeof refusal.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,79}$/.test(refusal.code)
  )
    return refusal.code;
}

export function semanticFailure(error: unknown, operation?: string): CallToolResult {
  const code =
    finiteCode(error) ?? (operation ? "WORKSPACE_OUTCOME_UNCONFIRMED" : "WORKSPACE_UNAVAILABLE");
  return semanticResult(
    {
      error: {
        code,
        message:
          localCodespaceFailureGuidance(code)?.message ??
          (operation
            ? "Collect the original operation before deciding on another action. An unavailable reply does not prove absence."
            : "The selected owner could not provide this observation."),
      },
      ...(operation ? { operation } : {}),
    },
    true,
  );
}
