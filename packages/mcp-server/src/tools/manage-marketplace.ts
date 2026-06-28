/**
 * MCP Tool: marketplace
 * Agent-facing marketplace operations backed by MarketplaceService.
 *
 * Actions:
 * - search:    find public flows (q/category/tags/sort/page) → store cards
 * - info:      full detail for one flow by `ref` ("handle/slug") (records a view)
 * - add:       adopt a flow into the library (reference, or `fork:true` editable copy)
 * - remove:    origin-aware removal — un-adopt an added reference (original untouched),
 *              but DELETE a flow you own (e.g. your own published listing)
 * - publish:   make one of your own workflows public (listed)
 * - unpublish: make your listed workflow private again
 * - rate:      rate/review a flow (1-5 stars; not your own)
 * - share:     privately share your workflow by link or with a specific user
 *
 * Store actions (search/info/add/publish/rate/share) require the marketplace to be
 * enabled; when disabled they return a clear "marketplace not enabled" message.
 */

import { z } from "zod";
import { ToolResult, WorkflowSpecificParams } from "./interfaces/tool-interface.js";
import { getUserContext } from "../core/request-context.js";
import { ERRORS, formatDomainError } from "../messages/index.js";
import { getMarketplaceService, isDomainError } from "@mcp-moira/shared";

type MarketplaceAction =
  | "search"
  | "info"
  | "add"
  | "remove"
  | "publish"
  | "unpublish"
  | "rate"
  | "share";

export interface ManageMarketplaceParams extends WorkflowSpecificParams {
  action: MarketplaceAction;
  // search
  q?: string;
  category?: string;
  tags?: string;
  sort?: "recent" | "rating" | "installs" | "trending";
  page?: number;
  // info / add / remove / rate (reference = "handle/slug")
  ref?: string;
  fork?: boolean;
  // rate
  stars?: number;
  review?: string;
  // publish / unpublish / share (workflow the caller owns)
  workflowId?: string;
  summary?: string;
  userHandle?: string;
}

export const manageMarketplaceSchema = z.object({
  action: z
    .enum(["search", "info", "add", "remove", "publish", "unpublish", "rate", "share"])
    .describe("Marketplace action to perform"),
  q: z.string().optional().describe("search: free-text query over title/summary"),
  category: z.string().optional().describe("search/publish: category id"),
  tags: z
    .string()
    .optional()
    .describe("search: match a single tag / publish: comma-separated tags"),
  sort: z
    .enum(["recent", "rating", "installs", "trending"])
    .optional()
    .describe("search: sort order (default recent)"),
  page: z.number().min(1).optional().describe("search: 1-based page (24 per page)"),
  ref: z.string().optional().describe('info/add/remove/rate: flow reference "handle/slug"'),
  fork: z
    .boolean()
    .optional()
    .describe("add: true → editable owned copy (fork); default reference"),
  stars: z.number().min(1).max(5).optional().describe("rate: 1-5 stars"),
  review: z.string().optional().describe("rate: optional review text"),
  workflowId: z.string().optional().describe("publish/unpublish/share: id of your workflow"),
  summary: z.string().optional().describe("publish: short summary"),
  userHandle: z.string().optional().describe("share: grant this user access (omit to make a link)"),
});

export type ManageMarketplaceSchemaType = z.infer<typeof manageMarketplaceSchema>;

const PAGE_SIZE = 24;

/** Build a "handle/slug" reference when the owner handle is known. */
function refOf(ownerHandle: string | null, slug: string): string | null {
  return ownerHandle ? `${ownerHandle}/${slug}` : null;
}

export async function manageMarketplace(
  params: ManageMarketplaceParams,
): Promise<ToolResult<unknown>> {
  try {
    const { userId } = getUserContext();
    const service = getMarketplaceService();
    const { action } = params;

    switch (action) {
      case "search": {
        const page = await service.getGallery({
          search: params.q,
          category: params.category,
          tag: params.tags,
          sort: params.sort ?? "recent",
          limit: PAGE_SIZE,
          offset: params.page && params.page > 1 ? (params.page - 1) * PAGE_SIZE : 0,
        });
        return {
          success: true,
          data: {
            total: page.total,
            page: params.page ?? 1,
            sort: page.sort,
            results: page.items.map((i) => ({
              ref: refOf(i.ownerHandle, i.slug),
              title: i.title,
              summary: i.summary,
              category: i.category,
              ratingAvg: i.ratingAvg,
              ratingCount: i.ratingCount,
              installCount: i.installCount,
              verified: i.verified,
              isPaid: i.isPaid,
              price: i.price,
            })),
          },
        };
      }

      case "info": {
        if (!params.ref) return { success: false, error: ERRORS.missing_required_field("ref") };
        const detail = await service.getDetailByReference(params.ref, userId);
        // Fire-and-forget view signal — never block or fail the info response.
        void service.recordView(detail.listing.id, userId).catch(() => {});
        return {
          success: true,
          data: {
            ref: detail.startRef,
            title: detail.listing.title,
            summary: detail.listing.summary,
            category: detail.listing.category,
            tags: JSON.parse(detail.listing.tags || "[]"),
            ownerHandle: detail.ownerHandle,
            ratingAvg: detail.listing.ratingAvg,
            ratingCount: detail.listing.ratingCount,
            installCount: detail.listing.installCount,
            verified: detail.listing.verified,
            isPaid: detail.listing.isPaid,
            price: detail.listing.price,
            entitlement: {
              hasAccess: detail.entitlement.accessible,
              reason: detail.entitlement.reason,
            },
            nodeCount: Array.isArray(detail.workflow.nodes) ? detail.workflow.nodes.length : 0,
          },
        };
      }

      case "add": {
        if (!params.ref) return { success: false, error: ERRORS.missing_required_field("ref") };
        const detail = await service.getDetailByReference(params.ref, userId);
        if (params.fork) {
          const forked = await service.fork(userId, detail.listing.id);
          return {
            success: true,
            data: { added: true, kind: "copy", workflowId: forked.workflowId, slug: forked.slug },
          };
        }
        const result = await service.install(userId, detail.listing.id);
        return {
          success: true,
          data: { added: true, kind: "reference", startRef: result.startRef },
        };
      }

      case "remove": {
        if (!params.ref) return { success: false, error: ERRORS.missing_required_field("ref") };
        const detail = await service.getDetailByReference(params.ref, userId);
        const removal = await service.remove(userId, detail.workflowId);
        return {
          success: true,
          data: { removed: true, ref: detail.startRef, ...removal },
        };
      }

      case "publish": {
        if (!params.workflowId)
          return { success: false, error: ERRORS.missing_required_field("workflowId") };
        const tags = params.tags
          ? params.tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined;
        const listing = await service.publish(userId, params.workflowId, {
          category: params.category,
          tags,
          summary: params.summary ?? null,
        });
        const detail = await service.getDetailById(listing.id, userId);
        return {
          success: true,
          data: { published: true, ref: detail.startRef, status: listing.status },
        };
      }

      case "unpublish": {
        if (!params.workflowId)
          return { success: false, error: ERRORS.missing_required_field("workflowId") };
        await service.unpublish(userId, params.workflowId);
        return { success: true, data: { unpublished: true, workflowId: params.workflowId } };
      }

      case "rate": {
        if (!params.ref) return { success: false, error: ERRORS.missing_required_field("ref") };
        if (params.stars === undefined)
          return { success: false, error: ERRORS.missing_required_field("stars") };
        const detail = await service.getDetailByReference(params.ref, userId);
        const result = await service.rate(userId, detail.listing.id, params.stars, params.review);
        return {
          success: true,
          data: {
            rated: true,
            ref: detail.startRef,
            stars: result.review.stars,
            ratingAvg: result.ratingAvg,
            ratingCount: result.ratingCount,
          },
        };
      }

      case "share": {
        if (!params.workflowId)
          return { success: false, error: ERRORS.missing_required_field("workflowId") };
        const result = await service.share(userId, params.workflowId, {
          userHandle: params.userHandle,
        });
        return { success: true, data: { shared: true, ...result } };
      }

      default: {
        return {
          success: false,
          error: ERRORS.unknown_action_with_valid(
            action,
            "search, info, add, remove, publish, unpublish, rate, share",
          ),
        };
      }
    }
  } catch (error) {
    if (isDomainError(error)) {
      return { success: false, error: formatDomainError(error) };
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: formatDomainError(new Error(errorMessage)) };
  }
}
