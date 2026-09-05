import { z } from "zod";
import { manageReconciliationSchema } from "./tool-schemas.js";
export { manageReconciliationSchema };
import { eq } from "drizzle-orm";
import {
  getDatabase,
  getSqliteInstance,
  getWorkflowMutationService,
  getWorkflowReconciliationStatus,
  getWorkflowReconciliationStatusSummary,
  WorkflowReconciliationRepository,
  resolveWorkflowReconciliation,
  WorkflowReconciliationStaleError,
  user,
} from "@mcp-moira/shared";
import { getUserContext } from "../core/request-context.js";
import { sanitizeMcpError } from "../utils/error-sanitizer.js";

export async function manageReconciliation(params: z.infer<typeof manageReconciliationSchema>) {
  try {
    const sqlite = getSqliteInstance();
    const { userId } = getUserContext();
    const db = getDatabase();
    const [actor] = await db
      .select({ isAdmin: user.isAdmin })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (params.action === "status") {
      const status = actor?.isAdmin
        ? getWorkflowReconciliationStatus(sqlite)
        : getWorkflowReconciliationStatusSummary(sqlite);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(status, null, 2),
          },
        ],
      };
    }
    if (params.action === "get") {
      if (!actor?.isAdmin) throw new Error("Administrator access is required");
      if (!params.reference) throw new Error("reference is required for get");
      const match =
        /^database:workflow-reconciliation:([^/]+)\/([^#]+)#(previous|current|incoming)$/.exec(
          params.reference,
        );
      if (!match) throw new Error("Invalid reconciliation candidate reference");
      const owner = decodeURIComponent(match[1]);
      const slug = decodeURIComponent(match[2]);
      const candidate = match[3] as "previous" | "current" | "incoming";
      const conflict = new WorkflowReconciliationRepository(sqlite).findConflict(owner, slug);
      if (!conflict) throw new Error("Reconciliation conflict not found");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { reference: params.reference, state: conflict[candidate] },
              null,
              2,
            ),
          },
        ],
      };
    }
    if (!params.reference || !params.selection || !params.revision || !params.rationale) {
      throw new Error("reference, selection, revision, and rationale are required for resolve");
    }
    if (params.mergedGraph && !params.visibility) {
      throw new Error("visibility is required with mergedGraph");
    }
    if (params.mergedGraph && params.selection !== "current") {
      throw new Error("mergedGraph requires selection=current");
    }
    if (!actor?.isAdmin) throw new Error("Administrator access is required");
    const merged = params.mergedGraph
      ? ({
          lifecycle: "present" as const,
          content: { graph: params.mergedGraph, visibility: params.visibility! },
        } as const)
      : undefined;
    await resolveWorkflowReconciliation(
      params.reference,
      params.selection,
      { sqlite, mutationService: getWorkflowMutationService() },
      merged,
      {
        actorId: userId,
        source: "mcp",
        expectedRevision: params.revision,
        rationale: params.rationale,
      },
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(getWorkflowReconciliationStatusSummary(sqlite), null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof WorkflowReconciliationStaleError) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "error",
                code: error.code,
                owner: error.owner,
                slug: error.slug,
                message: error.message,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: `Error: ${sanitizeMcpError(error)}` }],
      isError: true,
    };
  }
}
