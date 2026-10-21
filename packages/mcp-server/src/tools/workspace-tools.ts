import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createWorkspaceRequestId } from "@mcp-moira/shared/workspace-request-id";
import {
  decodeReference,
  encodeReference,
  isReference,
  type OwnerSelector,
  type OperationKind,
} from "@mcp-moira/shared/workspace-references";
import { getUserContext } from "../core/request-context.js";
import { semanticFailure, semanticResult } from "./workspace-presentation.js";
import {
  WORKSPACE_EFFECTS,
  WORKSPACE_TOOL_SCHEMAS,
  type WorkspaceToolName,
} from "./workspace-tool-contract.js";
import {
  communicationReceipt,
  executeCommunicationPurpose,
  type CommunicationPurposeDependencies,
  getCommunicationPurposeDependencies,
} from "./workspace-communication.js";

export interface SemanticWorkspaceClient {
  json(
    userId: string,
    id: string,
    request: { method: string; path: string; body?: unknown },
  ): Promise<Record<string, unknown>>;
}
export interface ResolvedSemanticWorkspace {
  workspace: SemanticWorkspaceClient;
  resourceId: string;
  owner: Exclude<OwnerSelector, { kind: "controller" }>;
}
export interface ResolvedSemanticController {
  controller: SemanticWorkspaceClient;
  deviceId: string;
  owner: Extract<OwnerSelector, { kind: "controller" }>;
}
export interface WorkspaceSemanticServices {
  invoke(
    userId: string,
    toolName: string,
    input: Record<string, unknown>,
    requestId?: string,
  ): Promise<unknown>;
  resolveWorkspace(
    userId: string,
    reference: string | OwnerSelector,
  ): Promise<ResolvedSemanticWorkspace>;
  resolveOwner(
    userId: string,
    owner: OwnerSelector,
  ): Promise<ResolvedSemanticWorkspace | ResolvedSemanticController>;
  resolveWorkspaceResource(userId: string, resourceId: string): Promise<ResolvedSemanticWorkspace>;
}
const cloudTools = new Set<WorkspaceToolName>([
  "workspace_list",
  "workspace_targets",
  "workspace_observe",
  "workspace_create",
  "workspace_lifecycle",
  "workspace_adopt",
  "workspace_delete",
  "workspace_setup_help",
  "workspace_adopt_external",
  "repository_admit",
  "repository_create",
  "operation_resume",
]);
function operationKind(name: WorkspaceToolName): OperationKind {
  if (name.startsWith("command_")) return "command";
  if (name.startsWith("file_")) return "file-change";
  if (name === "session_close") return "session";
  if (name === "pull_request_create") return "pull-request";
  return "lifecycle";
}
export function isWorkspaceToolName(name: unknown): name is WorkspaceToolName {
  return typeof name === "string" && Object.hasOwn(WORKSPACE_TOOL_SCHEMAS, name);
}
/** Only the public purpose is logged; commands, refs, attachment URLs and source text stay private. */
export function workspacePurposeLogContext(name: WorkspaceToolName) {
  return { inputData: { workspace_tool: name }, resourceIds: {} };
}
export function createWorkspaceToolHandler(
  services: WorkspaceSemanticServices,
  communication: CommunicationPurposeDependencies,
) {
  return async (name: WorkspaceToolName, raw: unknown, userId: string): Promise<CallToolResult> => {
    const request = WORKSPACE_TOOL_SCHEMAS[name].parse(raw) as Record<string, unknown>;
    if (name.startsWith("communication_"))
      return executeCommunicationPurpose(name, request, userId, services, communication);
    let operation: string | undefined;
    try {
      if (name === "operation_resume") operation = String(request.reference);
      if (cloudTools.has(name)) return semanticResult(await services.invoke(userId, name, request));
      let selected: ResolvedSemanticWorkspace | ResolvedSemanticController;
      if (name === "operation_get" || name === "process_output" || name === "process_stop") {
        const reference = String(request.reference ?? request.process);
        const original = isReference(reference, "operation")
          ? decodeReference(reference, "operation")
          : decodeReference(reference, "process");
        operation = isReference(reference, "operation")
          ? reference
          : encodeReference("operation", { ...original, kind: "command" });
        selected = await services.resolveOwner(userId, original.owner);
      } else if (name === "operation_find" && isReference(request.owner, "controller")) {
        const captured = decodeReference(String(request.owner), "controller");
        selected = await services.resolveOwner(userId, { kind: "controller", ...captured });
      } else {
        selected = await services.resolveWorkspace(
          userId,
          String(request.workspace ?? request.owner),
        );
      }
      if ("controller" in selected) {
        if (name === "operation_get" && isReference(request.reference, "operation")) {
          const original = decodeReference(String(request.reference), "operation");
          if (original.kind === "delivery")
            return communicationReceipt(
              await communication.owner.collect(userId, original.requestId, {
                deviceId: selected.deviceId,
              }),
              String(request.reference),
            );
        }
        return semanticResult(await services.invoke(userId, name, request));
      }
      const requestId = WORKSPACE_EFFECTS.has(name) ? createWorkspaceRequestId() : undefined;
      if (requestId)
        operation = encodeReference("operation", {
          owner: selected.owner,
          requestId,
          kind: operationKind(name),
        });
      return semanticResult(
        await selected.workspace.json(userId, selected.resourceId, {
          method: "POST",
          path: "/v1/tools",
          body: { action: name, request, ...(requestId ? { requestId } : {}) },
        }),
      );
    } catch (error) {
      return semanticFailure(error, operation);
    }
  };
}
export async function executeWorkspaceTool(
  name: WorkspaceToolName,
  request: unknown,
): Promise<CallToolResult> {
  const { getWorkspaceSemanticServices } = await import("@mcp-moira/web-backend/services");
  return createWorkspaceToolHandler(
    getWorkspaceSemanticServices(),
    await getCommunicationPurposeDependencies(),
  )(name, request, getUserContext().userId);
}
