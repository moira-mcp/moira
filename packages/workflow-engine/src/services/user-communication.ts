import type { IDataRepository } from "../interfaces/data-repository.js";

export type CommunicationFormat = "plain" | "markdown" | "html";
export type CommunicationPurpose = "notification" | "trusted";
export type CommunicationAttachmentKind = "image" | "document";

export interface CommunicationAttachment {
  kind: CommunicationAttachmentKind;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface PortableCommunicationMessage {
  text: string;
  format?: CommunicationFormat;
  silent?: boolean;
  attachment?: CommunicationAttachment;
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

export type CommunicationChannelStatus =
  "delivered" | "not_configured" | "unsupported" | "rate_limited" | "timed_out" | "failed";

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

export interface UserCommunicationLimits {
  maxRequestsPerWindow: number;
  windowMs: number;
  maxConcurrentPerUser: number;
  maxConcurrentPerProvider: number;
  deadlineMs: number;
  maxTextLength: number;
  maxAttachmentBytes: number;
  maxLimiterKeys: number;
}

const DEFAULT_LIMITS: UserCommunicationLimits = {
  maxRequestsPerWindow: 30,
  windowMs: 60_000,
  maxConcurrentPerUser: 4,
  maxConcurrentPerProvider: 8,
  deadlineMs: 10_000,
  maxTextLength: 4096,
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxLimiterKeys: 10_000,
};

interface LimitState {
  timestamps: number[];
  active: number;
}

type Availability =
  | { adapter: CommunicationChannelAdapter; configured: boolean }
  | { adapter: CommunicationChannelAdapter; result: CommunicationChannelResult };

export class UserCommunicationService {
  private readonly limits: UserCommunicationLimits;
  private readonly states = new Map<string, LimitState>();
  private readonly registry: CommunicationChannelRegistry;

  constructor(
    registry: CommunicationChannelRegistry | readonly CommunicationChannelAdapter[],
    limits: Partial<UserCommunicationLimits> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.registry =
      registry instanceof CommunicationChannelRegistry
        ? registry
        : new CommunicationChannelRegistry(registry);
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (this.limits.maxLimiterKeys < 1) throw new Error("maxLimiterKeys must be positive");
  }

  async deliver(
    request: UserCommunicationRequest,
    repository: IDataRepository,
  ): Promise<UserCommunicationResult> {
    this.validateRequest(request);
    const configuration: CommunicationConfigurationResolver = {
      get: <T>(key: string) => repository.getSetting<T>(request.userId, key),
    };
    const message: PortableCommunicationMessage = {
      text: request.text,
      format: request.format,
      silent: request.silent,
      attachment: request.attachment,
      purpose: request.purpose,
    };
    const availability = await Promise.all(
      this.registry
        .list()
        .map((adapter) => this.resolveAvailability(adapter, configuration, request.userId)),
    );
    const channels: CommunicationChannelResult[] = [];
    const configured: CommunicationChannelAdapter[] = [];
    for (const entry of availability) {
      if ("result" in entry) channels.push(entry.result);
      else if (entry.configured) configured.push(entry.adapter);
      else channels.push({ channelId: entry.adapter.id, status: "not_configured" });
    }

    channels.push(
      ...(await Promise.all(
        configured.map((adapter) =>
          this.deliverToAdapter(adapter, message, configuration, request.userId),
        ),
      )),
    );
    const eligibleConfiguredChannels = configured.filter((adapter) =>
      this.supports(adapter, message),
    ).length;
    return this.aggregate(channels, configured.length, eligibleConfiguredChannels);
  }

  /** Deliver a provider-neutral test message through one registered user channel. */
  async testChannel(
    channelId: string,
    userId: string,
    repository: IDataRepository,
  ): Promise<UserCommunicationResult | null> {
    const adapter = this.registry.get(channelId);
    if (!adapter) return null;
    const request: UserCommunicationRequest = {
      userId,
      text: "Test notification from MCP Moira.",
      format: "plain",
      purpose: "notification",
    };
    this.validateRequest(request);
    const configuration: CommunicationConfigurationResolver = {
      get: <T>(key: string) => repository.getSetting<T>(userId, key),
    };
    const availability = await this.resolveAvailability(adapter, configuration, userId);
    if ("result" in availability) return this.aggregate([availability.result], 0, 0);
    if (!availability.configured) {
      return this.aggregate([{ channelId, status: "not_configured" }], 0, 0);
    }
    const result = await this.deliverToAdapter(
      adapter,
      {
        text: request.text,
        format: request.format,
        purpose: request.purpose,
      },
      configuration,
      userId,
    );
    return this.aggregate([result], 1, this.supports(adapter, request) ? 1 : 0);
  }

  private aggregate(
    channels: CommunicationChannelResult[],
    configuredChannels: number,
    eligibleConfiguredChannels: number,
  ): UserCommunicationResult {
    const deliveredChannels = channels.filter((channel) => channel.status === "delivered").length;
    const availabilityFailed = channels.some(
      (channel) =>
        channel.status === "failed" ||
        channel.status === "timed_out" ||
        channel.status === "rate_limited",
    );
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

  private async resolveAvailability(
    adapter: CommunicationChannelAdapter,
    configuration: CommunicationConfigurationResolver,
    userId: string,
  ): Promise<Availability> {
    const rateKey = `rate:${userId}:${adapter.provider}`;
    const userKey = `availability:concurrency:user:${userId}`;
    const providerKey = `availability:concurrency:provider:${adapter.provider}`;
    if (!this.consumeRate(rateKey))
      return {
        adapter,
        result: {
          channelId: adapter.id,
          status: "rate_limited",
          reason: "rate_limit",
        },
      };
    if (!this.acquireConcurrency(userKey, this.limits.maxConcurrentPerUser))
      return {
        adapter,
        result: {
          channelId: adapter.id,
          status: "rate_limited",
          reason: "availability_concurrency_limit",
        },
      };
    if (!this.acquireConcurrency(providerKey, this.limits.maxConcurrentPerProvider)) {
      this.release(userKey);
      return {
        adapter,
        result: {
          channelId: adapter.id,
          status: "rate_limited",
          reason: "availability_concurrency_limit",
        },
      };
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const availability = Promise.resolve()
      .then(() => adapter.isConfigured(configuration, controller.signal))
      .finally(() => {
        this.release(providerKey);
        this.release(userKey);
      });
    try {
      const configured = await Promise.race([
        availability,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("communication_deadline"));
          }, this.limits.deadlineMs);
        }),
      ]);
      return { adapter, configured };
    } catch (error) {
      return {
        adapter,
        result: {
          channelId: adapter.id,
          status:
            error instanceof Error && error.message === "communication_deadline"
              ? "timed_out"
              : "failed",
          reason:
            error instanceof Error && error.message === "communication_deadline"
              ? "deadline_exceeded"
              : error instanceof CommunicationChannelError
                ? error.reason
                : "availability_error",
        },
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private validateRequest(request: UserCommunicationRequest): void {
    if (!request.userId) throw new Error("User communication requires an authenticated user");
    if (!request.text && !request.attachment)
      throw new Error("User communication requires text or an attachment");
    if (request.text.length > this.limits.maxTextLength)
      throw new Error("User communication text exceeds the configured limit");
    if (request.attachment) {
      if (request.attachment.bytes.byteLength === 0)
        throw new Error("User communication attachment is empty");
      if (request.attachment.bytes.byteLength > this.limits.maxAttachmentBytes)
        throw new Error("User communication attachment exceeds the configured limit");
      if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/.test(request.attachment.filename))
        throw new Error("User communication attachment filename is invalid");
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/.test(
          request.attachment.mimeType,
        )
      )
        throw new Error("User communication attachment MIME type is invalid");
    }
  }

  private supports(
    adapter: CommunicationChannelAdapter,
    message: PortableCommunicationMessage,
  ): boolean {
    if (message.purpose === "trusted" && !adapter.capabilities.trusted) return false;
    if (!message.attachment) return adapter.capabilities.text;
    return message.attachment.kind === "image"
      ? adapter.capabilities.image
      : adapter.capabilities.document;
  }

  private async deliverToAdapter(
    adapter: CommunicationChannelAdapter,
    message: PortableCommunicationMessage,
    configuration: CommunicationConfigurationResolver,
    userId: string,
  ): Promise<CommunicationChannelResult> {
    if (!this.supports(adapter, message)) return { channelId: adapter.id, status: "unsupported" };
    const userKey = `concurrency:user:${userId}`;
    const providerKey = `concurrency:provider:${adapter.provider}`;
    if (!this.acquireConcurrency(userKey, this.limits.maxConcurrentPerUser))
      return { channelId: adapter.id, status: "rate_limited" };
    if (!this.acquireConcurrency(providerKey, this.limits.maxConcurrentPerProvider)) {
      this.release(userKey);
      return { channelId: adapter.id, status: "rate_limited" };
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const delivery = Promise.resolve()
      .then(() => adapter.deliver(message, configuration, controller.signal))
      .finally(() => {
        this.release(providerKey);
        this.release(userKey);
      });
    try {
      await Promise.race([
        delivery,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("communication_deadline"));
          }, this.limits.deadlineMs);
        }),
      ]);
      return { channelId: adapter.id, status: "delivered" };
    } catch (error) {
      return {
        channelId: adapter.id,
        status:
          error instanceof Error && error.message === "communication_deadline"
            ? "timed_out"
            : "failed",
        reason:
          error instanceof Error && error.message === "communication_deadline"
            ? "deadline_exceeded"
            : error instanceof CommunicationChannelError
              ? error.reason
              : "channel_error",
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private consumeRate(key: string): boolean {
    const now = this.now();
    const state = this.stateFor(key, now);
    if (!state) return false;
    state.timestamps = state.timestamps.filter(
      (timestamp) => timestamp > now - this.limits.windowMs,
    );
    if (state.timestamps.length >= this.limits.maxRequestsPerWindow) return false;
    state.timestamps.push(now);
    return true;
  }

  private acquireConcurrency(key: string, concurrencyLimit: number): boolean {
    const now = this.now();
    const state = this.stateFor(key, now);
    if (!state || state.active >= concurrencyLimit) return false;
    state.active += 1;
    return true;
  }

  private stateFor(key: string, now: number): LimitState | null {
    const existing = this.states.get(key);
    if (existing) return existing;
    this.pruneExpiredStates(now);
    if (this.states.size >= this.limits.maxLimiterKeys) return null;
    const created = { timestamps: [], active: 0 };
    this.states.set(key, created);
    return created;
  }

  private pruneExpiredStates(now: number): void {
    for (const [key, state] of this.states) {
      state.timestamps = state.timestamps.filter(
        (timestamp) => timestamp > now - this.limits.windowMs,
      );
      if (state.active === 0 && state.timestamps.length === 0) this.states.delete(key);
    }
  }

  private release(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.active = Math.max(0, state.active - 1);
    if (state.active === 0 && state.timestamps.length === 0) this.states.delete(key);
  }
}
