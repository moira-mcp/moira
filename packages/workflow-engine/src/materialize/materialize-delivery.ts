import { metadataRevision } from "@mcp-moira/shared/metadata-revision";
import type { ExecutionError } from "@mcp-moira/shared/execution-error";
import type { WorkflowToken } from "@mcp-moira/shared/services/token-manager";
import {
  isMaterializeNode,
  type MaterializeNode,
  type WorkflowExecution,
  type WorkflowGraph,
} from "../types/index.js";
import {
  renderMaterializeFilesWithReport,
  type RenderedMaterializeFile,
} from "./materialize-service.js";

/**
 * Why a materialize delivery was refused. Both delivery channels answer with the same
 * classification, so a caller cannot learn from a refusal which channel it used or whether an
 * execution it does not own exists.
 */
export type MaterializeDenialReason =
  | "grant_invalid_or_expired"
  | "execution_binding_mismatch"
  | "workflow_node_unavailable"
  | "authorization_lost";

export interface MaterializeGrantStore {
  validateToken(token: string, expectedType: "materialize"): WorkflowToken | null;
  authorizeMaterializeToken(
    token: string,
    executionId: string,
    nodeId: string,
    userId: string,
    expectedContextRevision?: string,
  ): boolean;
}

export interface MaterializeExecutionSource {
  getExecution(executionId: string): Promise<WorkflowExecution | null>;
  getWorkflowGraph(workflowId: string, userId: string): Promise<WorkflowGraph | null>;
  /**
   * Record a fact about the run. Optional because a source may serve reads only; when it is
   * absent, a playbook that failed to resolve inside a materialized file is still logged, but not
   * attached to the execution.
   */
  appendError?(executionId: string, error: ExecutionError): Promise<boolean>;
}

export type MaterializeDelivery =
  | { authorized: true; files: RenderedMaterializeFile[]; executionId: string; nodeId: string }
  | { authorized: false; reason: MaterializeDenialReason };

export type MaterializeAuthorization =
  | {
      authorized: true;
      executionId: string;
      nodeId: string;
      userId: string;
      contextRevision: string;
      execution: WorkflowExecution;
      graph: WorkflowGraph;
      node: MaterializeNode;
    }
  | { authorized: false; reason: MaterializeDenialReason };

/** Check current grant authority without rendering text or resolving Note/Playbook references. */
export async function authorizeMaterializeDelivery(
  token: string,
  tokens: MaterializeGrantStore,
  source: MaterializeExecutionSource,
): Promise<MaterializeAuthorization> {
  const grant = tokens.validateToken(token, "materialize");
  if (!grant?.executionId || !grant.nodeId) {
    return { authorized: false, reason: "grant_invalid_or_expired" };
  }

  const execution = await source.getExecution(grant.executionId);
  if (
    !execution ||
    execution.userId !== grant.userId ||
    execution.status !== "running" ||
    execution.currentNodeId !== grant.nodeId ||
    execution.waitingForInputNodeId !== grant.nodeId
  ) {
    return { authorized: false, reason: "execution_binding_mismatch" };
  }

  const contextRevision = metadataRevision(execution.globalContext);
  if (grant.optionsJson) {
    let grantedRevision: unknown;
    try {
      grantedRevision = (JSON.parse(grant.optionsJson) as { contextRevision?: unknown })
        .contextRevision;
    } catch {
      return { authorized: false, reason: "grant_invalid_or_expired" };
    }
    if (grantedRevision !== undefined && typeof grantedRevision !== "string") {
      return { authorized: false, reason: "grant_invalid_or_expired" };
    }
    if (grantedRevision !== undefined && contextRevision !== grantedRevision) {
      return { authorized: false, reason: "execution_binding_mismatch" };
    }
  }

  const graph = await source.getWorkflowGraph(execution.workflowId, execution.userId);
  const node = graph?.nodes.find((candidate) => candidate.id === grant.nodeId);
  if (!graph || !node || !isMaterializeNode(node)) {
    return { authorized: false, reason: "workflow_node_unavailable" };
  }

  if (
    !tokens.authorizeMaterializeToken(
      token,
      execution.executionId,
      node.id,
      execution.userId,
      contextRevision,
    )
  ) {
    return { authorized: false, reason: "authorization_lost" };
  }
  return {
    authorized: true,
    executionId: execution.executionId,
    nodeId: node.id,
    userId: execution.userId,
    contextRevision,
    execution,
    graph,
    node,
  };
}

/** Render authorized workflow text, then reread the complete current grant/node/context authority. */
export async function resolveMaterializeDelivery(
  token: string,
  tokens: MaterializeGrantStore,
  source: MaterializeExecutionSource,
): Promise<MaterializeDelivery> {
  const initial = await authorizeMaterializeDelivery(token, tokens, source);
  if (initial.authorized === false) return initial;
  const { execution, graph, node } = initial;
  const { files, unresolvedPlaybooks } = await renderMaterializeFilesWithReport(
    node,
    graph.variableRegistry,
    execution.globalContext,
  );

  const current = await authorizeMaterializeDelivery(token, tokens, source);
  if (current.authorized === false) return current;
  if (
    current.executionId !== initial.executionId ||
    current.nodeId !== initial.nodeId ||
    current.userId !== initial.userId ||
    current.contextRevision !== initial.contextRevision
  ) {
    return { authorized: false, reason: "execution_binding_mismatch" };
  }

  if (unresolvedPlaybooks.length > 0) {
    // This records authorized text preparation, not successful archive or context delivery.
    await source.appendError?.(execution.executionId, {
      timestamp: Date.now(),
      nodeId: node.id,
      errorType: "degradation",
      message:
        `Prepared materialize text contains unresolved ${unresolvedPlaybooks.length === 1 ? "playbook reference" : "playbook references"}: ` +
        unresolvedPlaybooks.map((entry) => entry.reference).join(", "),
    });
    const afterRecording = await authorizeMaterializeDelivery(token, tokens, source);
    if (afterRecording.authorized === false) return afterRecording;
    if (
      afterRecording.executionId !== initial.executionId ||
      afterRecording.nodeId !== initial.nodeId ||
      afterRecording.userId !== initial.userId ||
      afterRecording.contextRevision !== initial.contextRevision
    ) {
      return { authorized: false, reason: "execution_binding_mismatch" };
    }
  }

  return { authorized: true, files, executionId: execution.executionId, nodeId: node.id };
}
