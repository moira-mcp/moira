/**
 * Playbooks API.
 *
 * A playbook is named, reusable behaviour text a workflow node references by name. These routes
 * serve the screen where people write and review that text; who may read or change one is decided
 * by the central authorization policy inside the service, not here.
 */

import { Router, Request, Response } from "express";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { AuthenticatedRequest } from "../types/express-types.js";
import { getPlaybookService, collectDefinitionReferences } from "@mcp-moira/shared";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";

const router = Router();
const playbooks = getPlaybookService();
const repository = new DatabaseRepository();

/**
 * Upper bound on the workflow definitions the live-run count reads.
 *
 * The count is asked interactively, before a save, and reads one definition per workflow that has
 * a running execution. Past this many definitions the answer says it is a lower bound rather than
 * pretending to be complete.
 */
const MAX_INSPECTED_WORKFLOWS = 200;

/**
 * Whether a definition names this playbook, however the owner is spelled.
 *
 * A reference may name the owner by handle, by id, or not at all when the author owns the
 * playbook; all of them resolve to one owner id, and that is what is compared.
 */
async function definitionNames(
  definition: unknown,
  authorId: string,
  ownerId: string,
  slug: string,
): Promise<boolean> {
  for (const reference of collectDefinitionReferences(definition)) {
    if (reference.name !== slug) continue;
    if ((await playbooks.resolveOwner(reference.owner, authorId)) === ownerId) return true;
  }
  return false;
}

/** GET /api/playbooks — the playbooks this user owns. */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { search, limit, offset } = req.query;

    const result = await playbooks.list(userId, {
      search: search ? String(search) : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });

    res.json({ success: true, data: result });
  }),
);

/** GET /api/playbooks/:name — one playbook, optionally at a past revision. */
router.get(
  "/:name",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const ownerId = await playbooks.resolveOwner(
      req.query.owner ? String(req.query.owner) : undefined,
      userId,
    );
    if (!ownerId) throw createApiError.notFound("Owner not found");

    const revision = req.query.revision ? Number(req.query.revision) : undefined;
    const found = await playbooks.get(userId, ownerId, req.params.name, revision);
    if (!found) throw createApiError.notFound("Playbook not found");

    res.json({ success: true, data: found });
  }),
);

/** PUT /api/playbooks/:name — create a playbook or write a new revision of it. */
router.put(
  "/:name",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { content, title, description } = req.body ?? {};
    if (typeof content !== "string") {
      throw createApiError.validationFailed("content must be a string");
    }

    const saved = await playbooks.save(userId, {
      slug: req.params.name,
      content,
      name: typeof title === "string" ? title : undefined,
      description: typeof description === "string" ? description : undefined,
    });

    res.json({ success: true, data: saved });
  }),
);

/** DELETE /api/playbooks/:name — remove a playbook and its history. */
router.delete(
  "/:name",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const removed = await playbooks.remove(userId, userId, req.params.name);
    if (!removed) throw createApiError.notFound("Playbook not found");
    res.json({ success: true, data: { name: req.params.name, deleted: true } });
  }),
);

/** GET /api/playbooks/:name/history — version history, newest first. */
router.get(
  "/:name/history",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const ownerId = await playbooks.resolveOwner(
      req.query.owner ? String(req.query.owner) : undefined,
      userId,
    );
    if (!ownerId) throw createApiError.notFound("Owner not found");

    const history = await playbooks.history(userId, ownerId, req.params.name);
    res.json({ success: true, data: { revisions: history } });
  }),
);

/** GET /api/playbooks/:name/compare — the difference between two revisions. */
router.get(
  "/:name/compare",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const ownerId = await playbooks.resolveOwner(
      req.query.owner ? String(req.query.owner) : undefined,
      userId,
    );
    if (!ownerId) throw createApiError.notFound("Owner not found");

    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw createApiError.validationFailed("from and to must be revision numbers");
    }

    const comparison = await playbooks.compare(userId, ownerId, req.params.name, from, to);
    if (!comparison) throw createApiError.notFound("Playbook revisions not found");
    res.json({ success: true, data: comparison });
  }),
);

/** POST /api/playbooks/:name/restore — put a past revision back in force. */
router.post(
  "/:name/restore",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const revision = Number(req.body?.revision);
    if (!Number.isInteger(revision)) {
      throw createApiError.validationFailed("revision must be a revision number");
    }

    const restored = await playbooks.restore(userId, userId, req.params.name, revision);
    if (!restored) throw createApiError.notFound("Playbook revision not found");
    res.json({ success: true, data: restored });
  }),
);

/** PUT /api/playbooks/:name/visibility — publish a playbook or make it private again. */
router.put(
  "/:name/visibility",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const visibility = req.body?.visibility;
    if (visibility !== "private" && visibility !== "public") {
      throw createApiError.validationFailed("visibility must be private or public");
    }

    const updated = await playbooks.setVisibility(userId, userId, req.params.name, visibility);
    res.json({ success: true, data: updated });
  }),
);

/**
 * GET /api/playbooks/:name/usage — running executions that read this playbook right now.
 *
 * Content resolves at every step, so editing a playbook changes the behaviour of runs already under
 * way. Whoever is about to save needs that number before saving, and it cannot be computed in the
 * browser: an execution stores a workflow id, while the reference lives inside the definition.
 * Only the caller's own running executions are considered, and each definition is read once
 * however many executions stand on it.
 */
router.get(
  "/:name/usage",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const name = req.params.name;

    const running = await repository.listExecutionsWithFilters({
      userId,
      status: ["running"],
      limit: 1000,
      offset: 0,
    });

    const byWorkflow = new Map<string, number>();
    for (const execution of running.executions) {
      byWorkflow.set(execution.workflowId, (byWorkflow.get(execution.workflowId) ?? 0) + 1);
    }

    const inspected = [...byWorkflow.keys()].slice(0, MAX_INSPECTED_WORKFLOWS);
    const complete = inspected.length === byWorkflow.size;

    let executions = 0;
    const workflows: { workflowId: string; name: string; executions: number }[] = [];
    for (const workflowId of inspected) {
      const graph = await repository.getWorkflowGraph(workflowId, userId);
      if (!graph || !(await definitionNames(graph, userId, userId, name))) continue;
      const count = byWorkflow.get(workflowId) ?? 0;
      executions += count;
      workflows.push({ workflowId, name: graph.metadata?.name ?? workflowId, executions: count });
    }

    res.json({ success: true, data: { name, executions, workflows, complete } });
  }),
);

export { router as playbooksRoutes };
