import { Router } from "express";
import { TokenManager, ValidationError, type WorkflowToken } from "@mcp-moira/shared";
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
  claimMaterializeToken(
    token: string,
    executionId: string,
    nodeId: string,
    userId: string,
  ): boolean;
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
        res.status(401).json({ error: "Invalid or expired materialize token" });
        return;
      }
      const execution = await repository.getExecution(grant.executionId);
      if (
        !execution ||
        execution.userId !== grant.userId ||
        execution.currentNodeId !== grant.nodeId ||
        execution.waitingForInputNodeId !== grant.nodeId
      ) {
        res.status(401).json({ error: "Invalid or expired materialize token" });
        return;
      }
      const graph = await repository.getWorkflowGraph(execution.workflowId, execution.userId);
      const node = graph?.nodes.find((candidate) => candidate.id === grant.nodeId);
      if (!graph || !node || !isMaterializeNode(node)) {
        res.status(401).json({ error: "Invalid or expired materialize token" });
        return;
      }

      const files = await renderMaterializeFiles(
        node,
        graph.variableRegistry,
        execution.globalContext,
      );
      const archive = await createMaterializeTar(files);
      if (!tokens.claimMaterializeToken(token, execution.executionId, node.id, execution.userId)) {
        res.status(401).json({ error: "Invalid or expired materialize token" });
        return;
      }
      res.setHeader("Content-Type", "application/x-tar");
      res.setHeader("Content-Disposition", 'attachment; filename="materialize.tar"');
      res.send(archive);
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: "Materialize archive could not be generated" });
        return;
      }
      next(error);
    }
  });
  return router;
}
