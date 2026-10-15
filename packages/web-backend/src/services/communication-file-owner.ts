import {
  parseCommunicationOwnerReference,
  communicationOwnerSubmitSchema,
  WORKSPACE_REQUEST_ID_PATTERN,
  type CommunicationOwnerScope,
  type CommunicationOwnerSubmit,
} from "@mcp-moira/shared";
import {
  CommunicationChannelOwnerUnavailableError,
  setActiveCommunicationFileOwner,
  type CommunicationFileOwner,
} from "@mcp-moira/workflow-engine";
import { getLocalDeviceService } from "./codespace-services.js";
import { getControllerClient, getWorkspaceClient } from "./workspace-client.js";
import { authorizeWorkspacePublication } from "./workspace-services.js";
import type { WorkspaceClient } from "./workspace-router.js";

function ownerFailure(
  error: unknown,
  requestId: string,
  owner: { device_id?: string; codespace_id?: string },
  collecting = false,
) {
  const value =
    error && typeof error === "object"
      ? (error as { statusCode?: unknown; details?: { error?: { code?: unknown } } })
      : null;
  const code = value?.details?.error?.code;
  // These are explicit owner pre-admission/source refusals, not status-only inference.
  if (
    typeof value?.statusCode === "number" &&
    typeof code === "string" &&
    [
      "SOURCE_REFUSED",
      "COMMUNICATION_SCOPE_REFUSED",
      "COMMUNICATION_SOURCE_REFUSED",
      "INVALID_REQUEST_ID",
      "COMMUNICATION_REQUEST_CONFLICT",
      "COMMUNICATION_OWNER_UNAVAILABLE",
      "PROGRESS_RENDERER_UNAVAILABLE",
    ].includes(code)
  )
    return {
      requestId,
      state:
        collecting ||
        ["COMMUNICATION_SCOPE_REFUSED", "COMMUNICATION_REQUEST_CONFLICT"].includes(code)
          ? "unconfirmed"
          : "completed",
      ...owner,
      outcome: {
        ok: false,
        error: {
          code,
          message: collecting
            ? "The owner refused access to the original receipt. Its previous outcome remains unconfirmed."
            : "The owner refused this source or request before delivery admission.",
        },
      },
    };
  return {
    requestId,
    state: "unconfirmed",
    ...owner,
    outcome: {
      ok: false,
      error: {
        code: "COMMUNICATION_OUTCOME_UNCONFIRMED",
        message:
          "The original receipt is unavailable. Collect this request before another explicit action.",
      },
    },
  };
}

export class LiveCommunicationFileOwner implements CommunicationFileOwner {
  constructor(
    private readonly dependencies: {
      devices: typeof getLocalDeviceService;
      controller: typeof getControllerClient;
      workspace: typeof getWorkspaceClient;
      authorizePublication: (resourceId: string) => string | Promise<string>;
    } = {
      devices: getLocalDeviceService,
      controller: getControllerClient,
      workspace: getWorkspaceClient,
      authorizePublication: authorizeWorkspacePublication,
    },
  ) {}
  async select(
    userId: string,
    deviceId?: string,
  ): Promise<Extract<CommunicationOwnerScope, { kind?: "controller" }>> {
    const devices = this.dependencies.devices();
    const candidates = (await devices.listOwned(userId)).devices.filter(
      (device) =>
        device.status === "active" &&
        device.owner.state === "available" &&
        (!deviceId || device.deviceId === deviceId),
    );
    if (candidates.length !== 1) throw new CommunicationChannelOwnerUnavailableError();
    const selected = candidates[0]!;
    const current = devices.getDeviceIdentity(userId, selected.deviceId);
    if (
      current.status !== "active" ||
      current.deviceGeneration !== selected.deviceGeneration ||
      current.connectionId !== selected.connectionId
    )
      throw new CommunicationChannelOwnerUnavailableError();
    return {
      kind: "controller",
      userId,
      deviceId: selected.deviceId,
      deviceGeneration: current.deviceGeneration,
      connectionId: current.connectionId,
    };
  }
  private async actor(
    userId: string,
    owner: { deviceId?: string; resourceId?: string },
  ): Promise<{
    client: WorkspaceClient;
    id: string;
    owner: { device_id?: string; codespace_id?: string };
  }> {
    if (owner.resourceId) {
      if (
        owner.deviceId ||
        (await this.dependencies.authorizePublication(owner.resourceId)) !== userId
      )
        throw new CommunicationChannelOwnerUnavailableError();
      return {
        client: this.dependencies.workspace(),
        id: owner.resourceId,
        owner: { codespace_id: owner.resourceId },
      };
    }
    const selected = await this.select(userId, owner.deviceId);
    return {
      client: this.dependencies.controller(),
      id: selected.deviceId,
      owner: { device_id: selected.deviceId },
    };
  }
  async submit(userId: string, value: CommunicationOwnerSubmit, deviceId?: string) {
    const input = communicationOwnerSubmitSchema.parse(value);
    let actor;
    if (input.source.type === "publication") {
      const reference = parseCommunicationOwnerReference(input.source.referenceId);
      if (deviceId && (reference.kind !== "controller" || reference.id !== deviceId))
        throw new CommunicationChannelOwnerUnavailableError();
      actor = await this.actor(
        userId,
        reference.kind === "controller" ? { deviceId: reference.id } : { resourceId: reference.id },
      );
    } else actor = await this.actor(userId, { deviceId });
    try {
      return {
        ...(await actor.client.json(userId, actor.id, {
          method: "POST",
          path: "/v1/communication",
          body: input,
        })),
        ...actor.owner,
      };
    } catch (error) {
      return ownerFailure(error, input.requestId, actor.owner);
    }
  }
  async collect(
    userId: string,
    requestId: string,
    owner: { deviceId?: string; resourceId?: string },
  ) {
    if (!WORKSPACE_REQUEST_ID_PATTERN.test(requestId) || (!owner.deviceId && !owner.resourceId))
      throw new Error("original_owner_required");
    const actor = await this.actor(userId, owner);
    try {
      return {
        ...(await actor.client.json(userId, actor.id, {
          method: "GET",
          path: `/v1/communication/operations/${requestId}`,
        })),
        ...actor.owner,
      };
    } catch (error) {
      return ownerFailure(error, requestId, actor.owner, true);
    }
  }
  async openPublication(userId: string, referenceId: string) {
    const reference = parseCommunicationOwnerReference(referenceId);
    const actor = await this.actor(
      userId,
      reference.kind === "workspace" ? { resourceId: reference.id } : { deviceId: reference.id },
    );
    const response = await actor.client.request(userId, actor.id, {
      method: "GET",
      path: `/v1/publications/${reference.token}`,
    });
    if (response.statusCode !== 200) {
      response.body.destroy();
      throw new CommunicationChannelOwnerUnavailableError();
    }
    return { headers: response.headers, body: response.body };
  }
}
let service: LiveCommunicationFileOwner | undefined;
export function initializeCommunicationFileOwner() {
  if (!service) {
    service = new LiveCommunicationFileOwner();
    setActiveCommunicationFileOwner(service);
  }
  return service;
}
