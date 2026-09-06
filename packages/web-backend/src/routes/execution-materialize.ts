import { Router, type Response } from "express";
import {
  createLogger,
  materializeDownloadsTotal,
  TokenManager,
  ValidationError,
  type WorkflowToken,
} from "@mcp-moira/shared";
import {
  DatabaseRepository,
  createMaterializeTar,
  isMaterializeNode,
  renderMaterializeFiles,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

interface MaterializeTokenStore {
  validateToken(token: string, expectedType: "materialize"): WorkflowToken | null;
  authorizeMaterializeToken(
    token: string,
    executionId: string,
    nodeId: string,
    userId: string,
  ): boolean;
}

const logger = createLogger({ component: "MaterializeDownload" });

type MaterializeDenialReason =
  | "grant_invalid_or_expired"
  | "execution_binding_mismatch"
  | "workflow_node_unavailable"
  | "authorization_lost";

function denyMaterialize(res: Response, reason: MaterializeDenialReason): void {
  materializeDownloadsTotal.inc({ outcome: "denied", reason });
  logger.warn("Materialize download denied", { reason });
  res.status(401).json({ error: "Invalid or expired materialize token" });
}

interface MaterializeRepository {
  getExecution(executionId: string): Promise<WorkflowExecution | null>;
  getWorkflowGraph(workflowId: string, userId: string): Promise<WorkflowGraph | null>;
}

export function createExecutionMaterializeRoutes(
  tokens: MaterializeTokenStore = TokenManager.getInstance(),
  repository: MaterializeRepository = new DatabaseRepository(),
): Router {
  const router = Router();
  router.get("/materialize/:token", async (req, res, next) => {
    const token = req.params.token;
    try {
      const grant = tokens.validateToken(token, "materialize");
      if (!grant?.executionId || !grant.nodeId) {
        denyMaterialize(res, "grant_invalid_or_expired");
        return;
      }
      const execution = await repository.getExecution(grant.executionId);
      if (
        !execution ||
        execution.userId !== grant.userId ||
        execution.currentNodeId !== grant.nodeId ||
        execution.waitingForInputNodeId !== grant.nodeId
      ) {
        denyMaterialize(res, "execution_binding_mismatch");
        return;
      }
      const graph = await repository.getWorkflowGraph(execution.workflowId, execution.userId);
      const node = graph?.nodes.find((candidate) => candidate.id === grant.nodeId);
      if (!graph || !node || !isMaterializeNode(node)) {
        denyMaterialize(res, "workflow_node_unavailable");
        return;
      }

      const files = await renderMaterializeFiles(
        node,
        graph.variableRegistry,
        execution.globalContext,
      );
      const archive = await createMaterializeTar(files);
      if (
        !tokens.authorizeMaterializeToken(token, execution.executionId, node.id, execution.userId)
      ) {
        denyMaterialize(res, "authorization_lost");
        return;
      }
      materializeDownloadsTotal.inc({ outcome: "success", reason: "authorized" });
      res.setHeader("Content-Type", "application/x-tar");
      res.setHeader("Content-Disposition", 'attachment; filename="materialize.tar"');
      res.send(archive);
    } catch (error) {
      if (error instanceof ValidationError) {
        materializeDownloadsTotal.inc({ outcome: "failed", reason: "archive_invalid" });
        res.status(400).json({ error: "Materialize archive could not be generated" });
        return;
      }
      next(error);
    }
  });
  return router;
}
