import * as AjvModule from "ajv";
import type {
  CommunicationChannelAdapter,
  CommunicationConfigurationResolver,
  PortableCommunicationMessage,
} from "../services/user-communication.js";
import { CommunicationChannelError } from "../services/user-communication.js";
import { DECLARED_SCHEMA_AJV_OPTIONS, canonicalJson } from "./declared-schema.js";
import type { RegisteredExtensionCommunicationChannel } from "./extension-contract.js";
import {
  ExtensionInvocationError,
  type ExtensionCommunicationChannelRequest,
  type IExtensionRunnerClient,
} from "./extension-runner-client.js";

export const DEFAULT_EXTENSION_COMMUNICATION_TIMEOUT_MS = 10_000;

interface ResolvedExtensionChannelConfiguration {
  configured: boolean;
  settings: Record<string, unknown>;
  secrets: Record<string, string | null>;
}

function stableRunnerReason(error: unknown): string {
  if (!(error instanceof ExtensionInvocationError)) return "runner_error";
  switch (error.kind) {
    case "timeout":
      return "runner_timeout";
    case "runner-unavailable":
      return "runner_unavailable";
    case "invalid-input":
      return "configuration_invalid";
    case "invalid-output":
    case "handler-error":
      return "handler_error";
  }
}

/** Adapts one manifest-declared channel to the provider-neutral communication boundary. */
export class ExtensionCommunicationChannelAdapter implements CommunicationChannelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly capabilities;
  readonly metadata;
  // Ajv ships as CommonJS in this workspace.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly ajv = new (AjvModule as any).default(DECLARED_SCHEMA_AJV_OPTIONS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private validator: any;

  constructor(
    readonly registered: RegisteredExtensionCommunicationChannel,
    private readonly client: IExtensionRunnerClient,
  ) {
    this.id = registered.declaration.id;
    this.provider = `extension.${registered.extensionName}`;
    this.capabilities = {
      text: registered.declaration.capabilities.text,
      image: registered.declaration.capabilities.image,
      document: registered.declaration.capabilities.document,
      // Unit 2 exposes eligibility metadata but does not expand trusted delivery itself.
      trusted: false,
    } as const;
    this.metadata = {
      title: registered.declaration.title,
      description: registered.declaration.description,
      origin: "extension",
      extensionName: registered.extensionName,
      extensionVersion: registered.extensionVersion,
      settingKeys: [
        ...(registered.declaration.settings ?? []),
        ...(registered.declaration.permissions?.secrets ?? []),
      ],
      enabledSetting: registered.declaration.enabledSetting,
      trustedDeliveryDeclared: registered.declaration.capabilities.trustedDelivery === true,
    } as const;
  }

  private async resolveConfiguration(
    configuration: CommunicationConfigurationResolver,
  ): Promise<ResolvedExtensionChannelConfiguration> {
    const declaration = this.registered.declaration;
    const byKey = new Map(
      this.registered.settingDeclarations.map((setting) => [setting.key, setting]),
    );
    const settings: Record<string, unknown> = {};
    const secrets: Record<string, string | null> = {};
    let configured = true;

    for (const key of declaration.settings ?? []) {
      const value = await configuration.get<unknown>(key);
      const setting = byKey.get(key);
      if (value === null || value === undefined) {
        if (setting?.required) configured = false;
      } else {
        settings[key] = value;
      }
    }
    for (const key of declaration.permissions?.secrets ?? []) {
      const value = await configuration.get<unknown>(key);
      const setting = byKey.get(key);
      if (value === null || value === undefined) {
        secrets[key] = null;
        if (setting?.required) configured = false;
      } else {
        secrets[key] = typeof value === "object" ? JSON.stringify(value) : String(value);
      }
    }

    if (!this.validator) {
      this.validator = this.ajv.compile(declaration.configurationSchema);
    }
    if (!this.validator(settings)) configured = false;
    if (settings[declaration.enabledSetting] === false) configured = false;
    return { configured, settings, secrets };
  }

  async isConfigurationValid(configuration: CommunicationConfigurationResolver): Promise<boolean> {
    return (await this.resolveConfiguration(configuration)).configured;
  }

  async checkRunner(signal: AbortSignal): Promise<void> {
    if (!this.client.checkCommunicationChannel) {
      throw new CommunicationChannelError("runner_incompatible");
    }
    try {
      await this.client.checkCommunicationChannel(
        this.id,
        DEFAULT_EXTENSION_COMMUNICATION_TIMEOUT_MS,
        signal,
      );
    } catch (error) {
      throw new CommunicationChannelError(stableRunnerReason(error));
    }
  }

  async isConfigured(
    configuration: CommunicationConfigurationResolver,
    signal: AbortSignal,
  ): Promise<boolean> {
    const resolved = await this.resolveConfiguration(configuration);
    if (!resolved.configured) return false;
    await this.checkRunner(signal);
    return true;
  }

  async deliver(
    message: PortableCommunicationMessage,
    configuration: CommunicationConfigurationResolver,
    signal: AbortSignal,
  ): Promise<void> {
    const resolved = await this.resolveConfiguration(configuration);
    if (!resolved.configured) throw new CommunicationChannelError("configuration_changed");
    if (!this.client.deliverCommunicationChannel) {
      throw new CommunicationChannelError("runner_incompatible");
    }
    const request: ExtensionCommunicationChannelRequest = {
      channelId: this.id,
      timeoutMs: DEFAULT_EXTENSION_COMMUNICATION_TIMEOUT_MS,
      message: {
        text: message.text,
        format: message.format,
        silent: message.silent,
        attachment: message.attachment,
      },
      ...(Object.keys(resolved.settings).length ? { settings: resolved.settings } : {}),
      ...(Object.keys(resolved.secrets).length ? { secrets: resolved.secrets } : {}),
    };
    try {
      await this.client.deliverCommunicationChannel(request, signal);
    } catch (error) {
      throw new CommunicationChannelError(stableRunnerReason(error));
    }
  }

  /** Stable declaration digest used to replace adapters after an extension upgrade. */
  identity(): string {
    return canonicalJson({
      extensionVersion: this.registered.extensionVersion,
      declaration: this.registered.declaration,
    });
  }
}
