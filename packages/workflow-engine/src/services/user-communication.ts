import type { IDataRepository } from "../interfaces/data-repository.js";

export type CommunicationFormat = "plain" | "markdown" | "html";
export type CommunicationPurpose = "notification" | "trusted";
export interface PortableCommunicationMessage {
  text: string;
  format?: CommunicationFormat;
  silent?: boolean;
  purpose?: CommunicationPurpose;
}

export interface UserCommunicationRequest extends PortableCommunicationMessage {
  userId: string;
}

export interface CommunicationConfigurationResolver {
  get<T = unknown>(key: string): Promise<T | null>;
}

export interface CommunicationChannelCapabilities {
  text: boolean;
  image: boolean;
  document: boolean;
  trusted: boolean;
}

export interface CommunicationChannelMetadata {
  title: string;
  description?: string;
  origin: "builtin" | "extension";
  extensionName?: string;
  extensionVersion?: string;
  settingKeys: readonly string[];
  enabledSetting?: string;
  helpUrl?: string;
  trustedDeliveryDeclared?: boolean;
}

export interface CommunicationChannelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly capabilities: CommunicationChannelCapabilities;
  readonly metadata: CommunicationChannelMetadata;
  /** A provider payload requirement, used only by a sender that explicitly fits its notification. */
  readonly textLimit?: number;
  isConfigured(
    configuration: CommunicationConfigurationResolver,
    signal: AbortSignal,
  ): Promise<boolean>;
  deliver(
    message: PortableCommunicationMessage,
    configuration: CommunicationConfigurationResolver,
    signal: AbortSignal,
  ): Promise<void>;
}

export type CommunicationChannelConfigurationState =
  "configured" | "not_configured" | "unavailable";

export const DEFAULT_COMMUNICATION_CONFIGURATION_DEADLINE_MS = 10_000;

/**
 * Resolve one adapter's user configuration without delivering or consuming delivery admission.
 * Provider exceptions and deadline expiry intentionally share the non-diagnostic unavailable state.
 */
export async function probeCommunicationChannelConfiguration(
  adapter: CommunicationChannelAdapter,
  configuration: CommunicationConfigurationResolver,
  deadlineMs = DEFAULT_COMMUNICATION_CONFIGURATION_DEADLINE_MS,
): Promise<CommunicationChannelConfigurationState> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    throw new Error("Communication configuration deadline must be positive");
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const configured = await Promise.race([
      Promise.resolve().then(() => adapter.isConfigured(configuration, controller.signal)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("communication_configuration_deadline"));
        }, deadlineMs);
      }),
    ]);
    return configured ? "configured" : "not_configured";
  } catch {
    return "unavailable";
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export const MAX_COMMUNICATION_CHANNEL_IDENTITY_LENGTH = 128;
const COMMUNICATION_CHANNEL_IDENTITY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Shared admission rule for channel and provider identities stored by the process registry. */
export function isCommunicationChannelIdentity(value: string): boolean {
  return (
    value.length <= MAX_COMMUNICATION_CHANNEL_IDENTITY_LENGTH &&
    COMMUNICATION_CHANNEL_IDENTITY_PATTERN.test(value)
  );
}

export class CommunicationChannelError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    const sanitizedReason = /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "channel_error";
    super(sanitizedReason);
    this.reason = sanitizedReason;
    this.name = "CommunicationChannelError";
  }
}

export class CommunicationChannelRegistry {
  private readonly adapters = new Map<string, CommunicationChannelAdapter>();

  constructor(initial: readonly CommunicationChannelAdapter[] = []) {
    for (const adapter of initial) this.register(adapter);
  }

  register(adapter: CommunicationChannelAdapter): void {
    if (
      !isCommunicationChannelIdentity(adapter.id) ||
      !isCommunicationChannelIdentity(adapter.provider)
    )
      throw new Error("Communication channel identity is invalid");
    if (this.adapters.has(adapter.id))
      throw new Error(`Communication channel '${adapter.id}' is already registered`);
    this.adapters.set(adapter.id, adapter);
  }

  unregister(channelId: string): boolean {
    return this.adapters.delete(channelId);
  }

  list(): readonly CommunicationChannelAdapter[] {
    return [...this.adapters.values()];
  }

  get(channelId: string): CommunicationChannelAdapter | undefined {
    return this.adapters.get(channelId);
  }
}

export type CommunicationChannelStatus = "delivered" | "not_configured" | "unsupported" | "failed";

export interface CommunicationChannelResult {
  channelId: string;
  status: CommunicationChannelStatus;
  reason?: string;
}

export type UserCommunicationStatus =
  "delivered" | "partial" | "no_configured_channels" | "all_failed";

export interface UserCommunicationResult {
  status: UserCommunicationStatus;
  configuredChannels: number;
  deliveredChannels: number;
  channels: CommunicationChannelResult[];
}

type PrepareMessage = (textLimit?: number) => Promise<PortableCommunicationMessage | null>;

export class UserCommunicationService {
  private readonly registry: CommunicationChannelRegistry;

  constructor(registry: CommunicationChannelRegistry | readonly CommunicationChannelAdapter[]) {
    this.registry =
      registry instanceof CommunicationChannelRegistry
        ? registry
        : new CommunicationChannelRegistry(registry);
  }

  async deliver(
    request: UserCommunicationRequest,
    repository: IDataRepository,
    prepare?: PrepareMessage,
  ): Promise<UserCommunicationResult> {
    this.validateRequest(request);
    const configuration: CommunicationConfigurationResolver = {
      get: <T>(key: string) => repository.getSetting<T>(request.userId, key),
    };
    const message: PortableCommunicationMessage = {
      text: request.text,
      format: request.format,
      silent: request.silent,
      purpose: request.purpose,
    };
    const attempts = await Promise.all(
      this.registry
        .list()
        .map((adapter) => this.deliverToAdapter(adapter, message, configuration, prepare)),
    );
    return this.aggregate(
      attempts.flatMap((attempt) => (attempt.result ? [attempt.result] : [])),
      attempts.filter((attempt) => attempt.configured).length,
      attempts.filter((attempt) => attempt.eligible).length,
    );
  }

  /** Deliver a provider-neutral test message through one registered user channel. */
  async testChannel(
    channelId: string,
    userId: string,
    repository: IDataRepository,
  ): Promise<UserCommunicationResult | null> {
    return this.deliverChannel(
      channelId,
      {
        userId,
        text: "Test notification from MCP Moira.",
        format: "plain",
        purpose: "notification",
      },
      repository,
    );
  }

  /** Deliver through one registered channel with the same configuration authority as fan-out. */
  async deliverChannel(
    channelId: string,
    request: UserCommunicationRequest,
    repository: IDataRepository,
    prepare?: PrepareMessage,
  ): Promise<UserCommunicationResult | null> {
    const adapter = this.registry.get(channelId);
    if (!adapter) return null;
    this.validateRequest(request);
    const configuration: CommunicationConfigurationResolver = {
      get: <T>(key: string) => repository.getSetting<T>(request.userId, key),
    };
    const attempt = await this.deliverToAdapter(
      adapter,
      {
        text: request.text,
        format: request.format,
        silent: request.silent,
        purpose: request.purpose,
      },
      configuration,
      prepare,
    );
    return this.aggregate(
      attempt.result ? [attempt.result] : [],
      Number(attempt.configured),
      Number(attempt.eligible),
    );
  }

  private aggregate(
    channels: CommunicationChannelResult[],
    configuredChannels: number,
    eligibleConfiguredChannels: number,
  ): UserCommunicationResult {
    const deliveredChannels = channels.filter((channel) => channel.status === "delivered").length;
    const availabilityFailed = channels.some((channel) => channel.status === "failed");
    return {
      status:
        eligibleConfiguredChannels === 0 && !availabilityFailed
          ? "no_configured_channels"
          : deliveredChannels === 0
            ? "all_failed"
            : deliveredChannels === configuredChannels && !availabilityFailed
              ? "delivered"
              : "partial",
      configuredChannels,
      deliveredChannels,
      channels,
    };
  }

  private validateRequest(request: UserCommunicationRequest): void {
    if (!request.userId) throw new Error("User communication requires an authenticated user");
    if (!request.text) throw new Error("User communication requires text");
  }

  private supports(
    adapter: CommunicationChannelAdapter,
    message: PortableCommunicationMessage,
  ): boolean {
    if (message.purpose === "trusted" && !adapter.capabilities.trusted) return false;
    return adapter.capabilities.text;
  }

  private async deliverToAdapter(
    adapter: CommunicationChannelAdapter,
    initial: PortableCommunicationMessage,
    configuration: CommunicationConfigurationResolver,
    prepare?: PrepareMessage,
  ): Promise<{ configured: boolean; eligible: boolean; result?: CommunicationChannelResult }> {
    const controller = new AbortController();
    let configured = false;
    let eligible = false;
    let preparingConfiguration = true;
    try {
      configured = await adapter.isConfigured(configuration, controller.signal);
      if (!configured)
        return {
          configured,
          eligible,
          result: { channelId: adapter.id, status: "not_configured" },
        };
      preparingConfiguration = false;
      if (!this.supports(adapter, initial))
        return { configured, eligible, result: { channelId: adapter.id, status: "unsupported" } };
      // Settings resolution yields. Refresh mutable content independently at each provider handoff.
      const message = prepare ? await prepare(adapter.textLimit) : initial;
      if (!message) return { configured, eligible };
      if (!message.text) throw new Error("User communication requires text");
      eligible = this.supports(adapter, message);
      if (!eligible)
        return { configured, eligible, result: { channelId: adapter.id, status: "unsupported" } };
      await adapter.deliver(message, configuration, controller.signal);
      return { configured, eligible, result: { channelId: adapter.id, status: "delivered" } };
    } catch (error) {
      return {
        configured,
        eligible,
        result: {
          channelId: adapter.id,
          status: "failed",
          reason:
            error instanceof CommunicationChannelError
              ? error.reason
              : preparingConfiguration
                ? "configuration_error"
                : "channel_error",
        },
      };
    }
  }
}
