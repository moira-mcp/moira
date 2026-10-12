import {
  AuditAction,
  CommunicationAttachmentGrantService,
  CommunicationGrantQuotaError,
  CodespaceResourceError,
  getBaseUrl,
  logAuditEventDirect,
  type CodespaceTransferService,
} from "@mcp-moira/shared";
import { DatabaseRepository, getActiveUserCommunicationService } from "@mcp-moira/workflow-engine";
import { getUserContext } from "../core/request-context.js";
import type { z } from "zod";
import type { communicationSchema } from "./tool-schemas.js";
import type { ToolCallResult } from "./tool-bindings.js";

type CommunicationInput = z.infer<typeof communicationSchema>;

export interface ManageCommunicationDependencies {
  communicationService: Pick<ReturnType<typeof getActiveUserCommunicationService>, "deliver"> &
    Partial<Pick<ReturnType<typeof getActiveUserCommunicationService>, "deliverChannel">>;
  transfers?: Pick<CodespaceTransferService, "getOwnedSource">;
  repository: DatabaseRepository;
  grantService: CommunicationAttachmentGrantService;
  baseUrl: string;
  audit: typeof logAuditEventDirect;
}

function result(value: unknown, isError = false): ToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError && { isError: true }),
  };
}

export function createManageCommunication(dependencies: ManageCommunicationDependencies) {
  return async (input: CommunicationInput): Promise<ToolCallResult> => {
    const { userId } = getUserContext();
    const { communicationService, repository, grantService, baseUrl, audit } = dependencies;
    if (input.action === "deliver-file") {
      if (
        !input.referenceId ||
        !dependencies.transfers ||
        [input.filename, input.mimeType, input.sizeBytes].some((field) => field !== undefined)
      ) {
        return result({ status: "rejected", reason: "private_file_reference_required" }, true);
      }
      let owned: Awaited<ReturnType<CodespaceTransferService["getOwnedSource"]>>;
      try {
        owned = await dependencies.transfers.getOwnedSource(userId, input.referenceId);
      } catch (error) {
        if (error instanceof CodespaceResourceError) {
          return result({ status: "rejected", reason: "private_file_unavailable" }, true);
        }
        throw error;
      }
      const kind = input.kind ?? "document";
      if (
        (kind === "image" && !["image/png", "image/jpeg"].includes(owned.record.mimeType)) ||
        (kind === "document" && owned.record.mimeType.startsWith("image/"))
      ) {
        return result({ status: "rejected", reason: "attachment_kind_mime_mismatch" }, true);
      }
      const request = {
        userId,
        text: input.message,
        format: input.format,
        silent: input.silent,
        purpose: "notification" as const,
        attachment: {
          kind,
          source: owned.source,
          filename: owned.record.fileName,
          mimeType: owned.record.mimeType,
        },
      };
      const delivery = input.channelId
        ? await communicationService.deliverChannel?.(input.channelId, request, repository)
        : await communicationService.deliver(request, repository);
      if (!delivery) return result({ status: "rejected", reason: "channel_unavailable" }, true);
      await audit(repository, {
        userId,
        action: AuditAction.MCP_COMMUNICATION_ATTACHMENT_DELIVER,
        resource: "communication",
        resourceId: owned.record.id,
        metadata: {
          kind,
          declaredSize: owned.source.size,
          status: delivery.status,
          configuredChannels: delivery.configuredChannels,
          deliveredChannels: delivery.deliveredChannels,
        },
      });
      return result(delivery, delivery.status === "all_failed");
    }
    if (input.referenceId || input.channelId) {
      return result({ status: "rejected", reason: "private_file_fields_not_allowed" }, true);
    }
    if (input.action === "send") {
      if (
        [input.kind, input.filename, input.mimeType, input.sizeBytes].some(
          (field) => field !== undefined,
        )
      ) {
        return result({ status: "rejected", reason: "attachment_fields_not_allowed" }, true);
      }
      const delivery = await communicationService.deliver(
        {
          userId,
          text: input.message,
          format: input.format,
          silent: input.silent,
          purpose: "notification",
        },
        repository,
      );
      await audit(repository, {
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

    try {
      if (!input.kind || !input.filename || !input.mimeType || input.sizeBytes === undefined) {
        return result({ status: "rejected", reason: "attachment_metadata_required" }, true);
      }
      const mimeType = input.mimeType.toLowerCase();
      if (
        (input.kind === "image" && !["image/png", "image/jpeg"].includes(mimeType)) ||
        (input.kind === "document" && mimeType.startsWith("image/"))
      ) {
        return result({ status: "rejected", reason: "attachment_kind_mime_mismatch" }, true);
      }
      const created = grantService.create({
        userId,
        message: input.message,
        format: input.format,
        silent: input.silent,
        kind: input.kind,
        filename: input.filename,
        mimeType,
        declaredSize: input.sizeBytes,
      });
      await audit(repository, {
        userId,
        action: AuditAction.MCP_COMMUNICATION_GRANT_CREATE,
        resource: "communication",
        resourceId: created.correlationId,
        metadata: { kind: input.kind, declaredSize: input.sizeBytes },
      });
      return result({
        uploadUrl: `${baseUrl}/api/communication/attachments`,
        grant: created.grant,
        expiresAt: new Date(created.expiresAt).toISOString(),
        correlationId: created.correlationId,
        requiredHeaders: {
          Authorization: "Bearer <valid MCP credential for the same user>",
          "X-Moira-Communication-Grant": "<grant>",
          "Content-Type": mimeType,
          "Content-Length": input.sizeBytes,
        },
      });
    } catch (error) {
      if (error instanceof CommunicationGrantQuotaError) {
        return result({ status: "rejected", reason: "outstanding_grant_quota" }, true);
      }
      throw error;
    }
  };
}

export async function manageCommunication(input: CommunicationInput): Promise<ToolCallResult> {
  const { getCodespaceTransferService } = await import("@mcp-moira/web-backend/services");
  return createManageCommunication({
    communicationService: getActiveUserCommunicationService(),
    repository: new DatabaseRepository(),
    grantService: new CommunicationAttachmentGrantService(),
    baseUrl: getBaseUrl(),
    audit: logAuditEventDirect,
    ...(input.action === "deliver-file" ? { transfers: getCodespaceTransferService() } : {}),
  })(input);
}
