import { metadataRevision, type ExecutionError, type WorkflowToken } from "@mcp-moira/shared";
import { isMaterializeNode, type WorkflowExecution, type WorkflowGraph } from "../types/index.js";
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

/**
 * Decide whether a materialize grant may be served right now, and render its files if so.
 *
 * This is the single place that owns the authorization decision. Both the archive endpoint and the
 * in-context fallback resolve through it, so the two channels cannot drift into disagreeing about
 * who may read what. Rendering happens before the final authorization re-check for the same reason
 * the archive endpoint has always done it: a render failure must not consume the decision.
 *
 * Throws whatever {@link renderMaterializeFilesWithReport} throws — a rendering or size violation is a
 * different outcome from a refusal and each caller maps it to its own transport.
 */
export async function resolveMaterializeDelivery(
  token: string,
  tokens: MaterializeGrantStore,
  source: MaterializeExecutionSource,
): Promise<MaterializeDelivery> {
  const grant = tokens.validateToken(token, "materialize");
  if (!grant?.executionId || !grant.nodeId) {
    return { authorized: false, reason: "grant_invalid_or_expired" };
  }

  const execution = await source.getExecution(grant.executionId);
  if (
    !execution ||
    execution.userId !== grant.userId ||
    execution.currentNodeId !== grant.nodeId ||
    execution.waitingForInputNodeId !== grant.nodeId
  ) {
    return { authorized: false, reason: "execution_binding_mismatch" };
  }

  if (grant.optionsJson) {
    let contextRevision: string | undefined;
    try {
      contextRevision = (JSON.parse(grant.optionsJson) as { contextRevision?: string })
        .contextRevision;
    } catch {
      return { authorized: false, reason: "grant_invalid_or_expired" };
    }
    if (contextRevision && metadataRevision(execution.globalContext) !== contextRevision) {
      return { authorized: false, reason: "execution_binding_mismatch" };
    }
  }

  const graph = await source.getWorkflowGraph(execution.workflowId, execution.userId);
  const node = graph?.nodes.find((candidate) => candidate.id === grant.nodeId);
  if (!graph || !node || !isMaterializeNode(node)) {
    return { authorized: false, reason: "workflow_node_unavailable" };
  }

  const { files, unresolvedPlaybooks } = await renderMaterializeFilesWithReport(
    node,
    graph.variableRegistry,
    execution.globalContext,
  );

  if (unresolvedPlaybooks.length > 0) {
    // The placeholder lands inside a delivered file, where nobody reading the run would see it.
    await source.appendError?.(execution.executionId, {
      timestamp: Date.now(),
      nodeId: node.id,
      errorType: "degradation",
      message:
        `Materialized files were delivered without ${unresolvedPlaybooks.length === 1 ? "a playbook" : "playbooks"} they reference: ` +
        unresolvedPlaybooks.map((entry) => entry.reference).join(", "),
    });
  }

  if (!tokens.authorizeMaterializeToken(token, execution.executionId, node.id, execution.userId)) {
    return { authorized: false, reason: "authorization_lost" };
  }

  return { authorized: true, files, executionId: execution.executionId, nodeId: node.id };
}
