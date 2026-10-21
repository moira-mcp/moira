import {
  AuditAction,
  logAuditEventDirect,
  parseCommunicationOwnerReference,
  communicationOwnerReceiptSchema,
} from "@mcp-moira/shared";
import { createWorkspaceRequestId } from "@mcp-moira/shared/workspace-request-id";
import {
  decodeReference,
  encodeReference,
  type OwnerSelector,
} from "@mcp-moira/shared/workspace-references";
import {
  DatabaseRepository,
  getActiveCommunicationFileOwner,
  getActiveUserCommunicationService,
  type CommunicationFileOwner,
} from "@mcp-moira/workflow-engine";
import { semanticFailure, semanticResult } from "./workspace-presentation.js";
import type { WorkspaceSemanticServices } from "./workspace-tools.js";
import type { WorkspaceToolName } from "./workspace-tool-contract.js";
import { operationState } from "@mcp-moira/shared/workspace-operation-state";

export interface CommunicationPurposeDependencies {
  communicationService: Pick<
    ReturnType<typeof getActiveUserCommunicationService>,
    "deliver" | "deliverChannel"
  >;
  owner: CommunicationFileOwner;
  repository: DatabaseRepository;
  audit: typeof logAuditEventDirect;
}
/** Public references replace transport identities; journal outcomes remain the owner's original values. */
export function communicationReceipt(value: Record<string, unknown>, operation: string) {
  const {
    requestId: _requestId,
    state,
    ...receipt
  } = communicationOwnerReceiptSchema.strip().parse(value);
  return semanticResult({ ...receipt, state: operationState({ ...receipt, state }), operation });
}
export async function executeCommunicationPurpose(
  name: WorkspaceToolName,
  request: Record<string, unknown>,
  userId: string,
  services: WorkspaceSemanticServices,
  dependencies: CommunicationPurposeDependencies,
) {
  let operation: string | undefined;
  try {
    if (name === "communication_send") {
      const message = {
        userId,
        text: String(request.message),
        format: request.format as "plain" | "markdown" | "html" | undefined,
        silent: request.silent as boolean | undefined,
        purpose: "notification" as const,
      };
      const delivery =
        typeof request.channel === "string"
          ? await dependencies.communicationService.deliverChannel(
              request.channel,
              message,
              dependencies.repository,
            )
          : await dependencies.communicationService.deliver(message, dependencies.repository);
      if (!delivery)
        return semanticResult(
          {
            error: {
              code: "COMMUNICATION_CHANNEL_UNAVAILABLE",
              message: "The selected configured channel is unavailable.",
            },
          },
          true,
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
      return semanticResult(delivery, delivery.status === "all_failed");
    }
    let selected: OwnerSelector;
    let scope: Awaited<ReturnType<CommunicationFileOwner["select"]>> | undefined;
    if (name === "communication_deliver_publication") {
      const source = parseCommunicationOwnerReference(request.publication);
      if (source.kind === "workspace")
        selected = (await services.resolveWorkspaceResource(userId, source.id)).owner;
      else {
        scope = await dependencies.owner.select(userId, source.id);
        selected = {
          kind: "controller",
          deviceId: scope.deviceId,
          connectionId: scope.connectionId,
        };
      }
    } else {
      const explicit =
        typeof request.owner === "string"
          ? decodeReference(request.owner, "controller")
          : undefined;
      scope = await dependencies.owner.select(userId, explicit?.deviceId);
      if (explicit && scope.connectionId !== explicit.connectionId)
        return semanticResult(
          {
            error: {
              code: "LOCAL_UNAUTHORIZED",
              message: "The selected computer connection changed.",
            },
          },
          true,
        );
      selected = { kind: "controller", deviceId: scope.deviceId, connectionId: scope.connectionId };
    }
    const requestId = createWorkspaceRequestId();
    operation = encodeReference("operation", { owner: selected, requestId, kind: "delivery" });
    const file = request.file as
      | {
          file_id: string;
          download_url: string;
          file_name?: string;
          mime_type?: string;
          size_bytes?: number;
        }
      | undefined;
    const receipt = await dependencies.owner.submit(
      userId,
      {
        action: "deliver",
        requestId,
        ...(scope ? { expectedScope: scope } : {}),
        source: file
          ? {
              type: "native",
              file: {
                fileId: file.file_id,
                downloadUrl: file.download_url,
                fileName: file.file_name,
                mimeType: file.mime_type,
                declaredSize: file.size_bytes,
              },
            }
          : { type: "publication", referenceId: String(request.publication) },
        kind: request.kind as "image" | "document",
        text: typeof request.message === "string" ? request.message : "",
        format: request.format as "plain" | "markdown" | "html" | undefined,
        silent: request.silent as boolean | undefined,
        ...(typeof request.channel === "string" ? { channelIds: [request.channel] } : {}),
      },
      selected.kind === "controller" ? selected.deviceId : undefined,
    );
    return communicationReceipt(receipt, operation);
  } catch (error) {
    return semanticFailure(error, operation);
  }
}
export async function getCommunicationPurposeDependencies(): Promise<CommunicationPurposeDependencies> {
  const { initializeCommunicationFileOwner } = await import("@mcp-moira/web-backend/services");
  initializeCommunicationFileOwner();
  return {
    communicationService: getActiveUserCommunicationService(),
    owner: getActiveCommunicationFileOwner(),
    repository: new DatabaseRepository(),
    audit: logAuditEventDirect,
  };
}
