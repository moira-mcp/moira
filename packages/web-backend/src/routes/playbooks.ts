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
import { getPlaybookService } from "@mcp-moira/shared";

const router = Router();
const playbooks = getPlaybookService();

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

export { router as playbooksRoutes };
