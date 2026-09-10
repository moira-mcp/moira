import { materializeDownloadsTotal, TokenManager, ValidationError } from "@mcp-moira/shared";
import {
  assertMaterializeContextBudget,
  resolveMaterializeDelivery,
  type MaterializeExecutionSource,
  type MaterializeGrantStore,
} from "@mcp-moira/workflow-engine";
import { ERRORS } from "../messages/index.js";
import { MCPEngine } from "../core/mcp-engine.js";
import type { ToolResult } from "./interfaces/tool-interface.js";

/** Materialize files delivered into the caller's context instead of onto a filesystem. */
export interface MaterializeDeliveryData {
  files: Array<{ path: string; content: string }>;
}

export interface MaterializeGrantResolver extends MaterializeGrantStore {
  getCurrentMaterializeGrant(executionId: string, userId: string): { token: string } | null;
}

export interface MaterializeDeliveryDependencies {
  tokens: MaterializeGrantResolver;
  repository: MaterializeExecutionSource;
}

/**
 * Serve a materialize node's files to the agent that is paused on it.
 *
 * This is the fallback for a host that cannot run the presented shell command: the bytes travel in
 * the tool response instead of through the archive URL. It carries no token of its own — the grant
 * of the execution's current presentation is resolved server-side — so a caller can only ever
 * reach its own paused execution.
 *
 * Every refusal answers with one message. Telling the caller which condition failed would reveal
 * whether an execution it does not own exists.
 */
export async function deliverMaterializeToContext(
  executionId: string,
  userId: string,
  dependencies?: Partial<MaterializeDeliveryDependencies>,
): Promise<ToolResult<MaterializeDeliveryData>> {
  const tokens = dependencies?.tokens ?? TokenManager.getInstance();
  const repository = dependencies?.repository ?? MCPEngine.getInstance().repository;

  const grant = tokens.getCurrentMaterializeGrant(executionId, userId);
  if (!grant) {
    materializeDownloadsTotal.inc({ outcome: "denied", reason: "grant_invalid_or_expired" });
    return { success: false, error: ERRORS.materialize_unavailable };
  }

  try {
    const delivery = await resolveMaterializeDelivery(grant.token, tokens, repository);
    if (!delivery.authorized) {
      materializeDownloadsTotal.inc({ outcome: "denied", reason: delivery.reason });
      return { success: false, error: ERRORS.materialize_unavailable };
    }

    assertMaterializeContextBudget(delivery.files);
    materializeDownloadsTotal.inc({ outcome: "success", reason: "context_fallback" });
    return {
      success: true,
      data: {
        files: delivery.files.map((file) => ({
          path: file.path,
          content: file.content.toString("utf8"),
        })),
      },
    };
  } catch (error) {
    if (error instanceof ValidationError) {
      materializeDownloadsTotal.inc({ outcome: "failed", reason: "context_delivery_invalid" });
      return { success: false, error: error.message };
    }
    throw error;
  }
}
