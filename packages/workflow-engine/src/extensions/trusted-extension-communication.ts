import { isExtensionNodeType } from "./extension-contract.js";
import type { ExtensionRegistry } from "./extension-registry.js";
import {
  isCommunicationChannelIdentity,
  type CommunicationConfigurationResolver,
} from "../services/user-communication.js";
import type { ExtensionCommunicationChannelReconciler } from "./extension-communication-reconciler.js";

export const TRUSTED_EXTENSION_CHANNEL_SETTING_PREFIX = "extensions.trusted_communication_channel.";

export interface TrustedExtensionChannelApprovalStore {
  get(key: string): Promise<{ value: string | null } | null>;
  setValue(key: string, value: string | null, adminUserId: string): Promise<void>;
  create(
    setting: {
      key: string;
      value?: string | null;
      type: "boolean";
      label: string;
      description: string | null;
      category: string;
      sortOrder?: number;
    },
    adminUserId: string,
  ): Promise<void>;
}

function approvalKey(channelId: string): string {
  if (!isExtensionNodeType(channelId) || !isCommunicationChannelIdentity(channelId)) {
    throw new Error("Trusted communication channel identity is invalid");
  }
  return `${TRUSTED_EXTENSION_CHANNEL_SETTING_PREFIX}${channelId}`;
}

/** Audited persisted administrator decision, independent of extension declarations. */
export class TrustedExtensionChannelApprovalService {
  constructor(private readonly store: TrustedExtensionChannelApprovalStore) {}

  async isApproved(channelId: string): Promise<boolean> {
    const setting = await this.store.get(approvalKey(channelId));
    return setting?.value === "true" || setting?.value === "1";
  }

  async setApproved(channelId: string, approved: boolean, adminUserId: string): Promise<void> {
    const key = approvalKey(channelId);
    const existing = await this.store.get(key);
    const value = approved ? "true" : "false";
    if (existing) {
      await this.store.setValue(key, value, adminUserId);
      return;
    }
    await this.store.create(
      {
        key,
        value,
        type: "boolean",
        label: `Trusted delivery approval: ${channelId}`,
        description:
          "Installation-wide administrator approval for this extension communication channel.",
        category: "extensions",
      },
      adminUserId,
    );
  }
}

export interface TrustedExtensionChannelEligibility {
  channelId: string;
  declared: boolean;
  approved: boolean;
  healthy: boolean;
  configured: boolean;
  eligible: boolean;
}

/** Computes trusted eligibility without ever delivering a trusted payload. */
export class TrustedExtensionChannelEligibilityService {
  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly reconciler: ExtensionCommunicationChannelReconciler,
    private readonly approvals: TrustedExtensionChannelApprovalService,
  ) {}

  async evaluate(
    channelId: string,
    configuration: CommunicationConfigurationResolver,
  ): Promise<TrustedExtensionChannelEligibility> {
    const registered = this.registry.getCommunicationChannel(channelId);
    const adapter = this.reconciler.get(channelId);
    const declared = registered?.declaration.capabilities.trustedDelivery === true;
    const approved = await this.approvals.isApproved(channelId);
    let configured = false;
    let healthy = false;
    if (adapter) {
      try {
        configured = await adapter.isConfigurationValid(configuration);
      } catch {
        configured = false;
      }
      try {
        await adapter.checkRunner(new AbortController().signal);
        healthy = true;
      } catch {
        healthy = false;
      }
    }
    return {
      channelId,
      declared,
      approved,
      healthy,
      configured,
      eligible: declared && approved && healthy && configured,
    };
  }
}
