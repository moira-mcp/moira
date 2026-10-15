import {
  AuditAction,
  logAuditEventDirect,
  communicationOwnerReceiptSchema,
} from "@mcp-moira/shared";
import {
  DatabaseRepository,
  getActiveCommunicationFileOwner,
  getActiveUserCommunicationService,
  type CommunicationFileOwner,
} from "@mcp-moira/workflow-engine";
import { getUserContext } from "../core/request-context.js";
import type { z } from "zod";
import type { communicationSchema } from "./tool-schemas.js";
import type { ToolCallResult } from "./tool-bindings.js";

type CommunicationInput = z.infer<typeof communicationSchema>;
export interface ManageCommunicationDependencies {
  communicationService: Pick<ReturnType<typeof getActiveUserCommunicationService>, "deliver">;
  owner?: CommunicationFileOwner;
  repository: DatabaseRepository;
  audit: typeof logAuditEventDirect;
}
function result(value: unknown, isError = false): ToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError && { isError: true }),
  };
}
function ownerResult(value: unknown): ToolCallResult {
  const receipt = communicationOwnerReceiptSchema.passthrough().parse(value);
  return result(value, receipt.state === "unconfirmed" || receipt.outcome?.ok === false);
}
export function createManageCommunication(dependencies: ManageCommunicationDependencies) {
  return async (input: CommunicationInput): Promise<ToolCallResult> => {
    const { userId } = getUserContext();
    if (input.action === "send") {
      if (
        !input.message ||
        input.referenceId ||
        input.file ||
        input.kind ||
        input.channelId ||
        input.request_id ||
        input.device_id ||
        input.codespace_id
      )
        return result({ status: "rejected", reason: "text_fields_required" }, true);
      const delivery = await dependencies.communicationService.deliver(
        {
          userId,
          text: input.message,
          format: input.format,
          silent: input.silent,
          purpose: "notification",
        },
        dependencies.repository,
      );
      await dependencies.audit(dependencies.repository, {
        userId,
        action: AuditAction.MCP_COMMUNICATION_SEND,
        resource: "communication",
        metadata: {
          status: delivery.status,
          configuredChannels: delivery.configuredChannels,
          deliveredChannels: delivery.deliveredChannels,
        },
      });
      return result(delivery, delivery.status === "all_failed");
    }
    if (!input.request_id)
      return result({ status: "rejected", reason: "original_request_id_required" }, true);
    if (
      input.action === "operation" &&
      ((!input.device_id && !input.codespace_id) ||
        (input.device_id && input.codespace_id) ||
        input.file ||
        input.referenceId ||
        input.message !== undefined ||
        input.kind ||
        input.channelId ||
        input.format ||
        input.silent !== undefined)
    )
      return result({ status: "rejected", reason: "original_owner_identity_required" }, true);
    try {
      const owner = dependencies.owner ?? getActiveCommunicationFileOwner();
      if (input.action === "operation") {
        return ownerResult(
          await owner.collect(userId, input.request_id, {
            deviceId: input.device_id,
            resourceId: input.codespace_id,
          }),
        );
      }
      if (
        (!input.file && !input.referenceId) ||
        (input.file && input.referenceId) ||
        input.codespace_id
      )
        return result({ status: "rejected", reason: "one_owner_source_required" }, true);
      const source = input.file
        ? {
            type: "native" as const,
            file: {
              fileId: input.file.file_id,
              downloadUrl: input.file.download_url,
              fileName: input.file.file_name,
              mimeType: input.file.mime_type,
              declaredSize: input.file.size_bytes,
            },
          }
        : { type: "publication" as const, referenceId: input.referenceId! };
      const receipt = await owner.submit(
        userId,
        {
          action: "deliver",
          requestId: input.request_id,
          source,
          kind: input.kind ?? "document",
          text: input.message ?? "",
          format: input.format,
          silent: input.silent,
          ...(input.channelId ? { channelIds: [input.channelId] } : {}),
        },
        input.device_id,
      );
      return ownerResult(receipt);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : "COMMUNICATION_OUTCOME_UNCONFIRMED";
      return result(
        {
          status: code === "COMMUNICATION_OWNER_UNAVAILABLE" ? "unavailable" : "unconfirmed",
          error: {
            code,
            message:
              code === "COMMUNICATION_OWNER_UNAVAILABLE"
                ? "The selected owner is unavailable for this attempt; the original delivery outcome remains unconfirmed. Collect the same request when access is restored."
                : "The delivery outcome is unconfirmed. Collect the original request before another explicit action.",
          },
          request_id: input.request_id,
          ...(input.device_id ? { device_id: input.device_id } : {}),
          ...(input.codespace_id ? { codespace_id: input.codespace_id } : {}),
        },
        true,
      );
    }
  };
}
export async function manageCommunication(input: CommunicationInput): Promise<ToolCallResult> {
  const { initializeCommunicationFileOwner } = await import("@mcp-moira/web-backend/services");
  initializeCommunicationFileOwner();
  return createManageCommunication({
    communicationService: getActiveUserCommunicationService(),
    repository: new DatabaseRepository(),
    audit: logAuditEventDirect,
  })(input);
}
