import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  canonicalJson,
  metadataRevision,
  communicationOwnerPrepareSchema,
  communicationOwnerSendSchema,
  type CommunicationOwnerChannel,
  type CommunicationOwnerPrepare,
  type CommunicationOwnerScope,
  type CommunicationOwnerSend,
  type CommunicationVendorResult,
} from "@mcp-moira/shared";
import {
  ExtensionCommunicationChannelAdapter,
  getActiveCommunicationChannelRegistry,
  DatabaseRepository,
  type CommunicationChannelRegistry,
  type IDataRepository,
  TELEGRAM_PHOTO_MAX_BYTES,
  TELEGRAM_DOCUMENT_MAX_BYTES,
  TELEGRAM_CAPTION_MAX_LENGTH,
  TELEGRAM_TEXT_MAX_LENGTH,
} from "@mcp-moira/workflow-engine";
import { binaryControlsSchema } from "@mcp-moira/workflow-engine/extensions/contract";
import { fetchWork } from "@mcp-moira/shared/http/work-fetch";

type ExtensionConfiguration = Awaited<
  ReturnType<ExtensionCommunicationChannelAdapter["resolveBinaryConfiguration"]>
>;
type Channel = {
  public: CommunicationOwnerChannel;
} & (
  | { kind: "telegram"; token: string; recipient: string }
  | {
      kind: "extension";
      adapter: ExtensionCommunicationChannelAdapter;
      configuration: ExtensionConfiguration;
    }
);

/** Only current account/actor authentication and installed channel configuration enter this edge. */
export class CommunicationOwnerTransport {
  constructor(
    private readonly dependencies: {
      authenticate(bearer: string): Promise<void> | void;
      authorize(bearer: string, scope: CommunicationOwnerScope): Promise<string> | string;
      repository?: IDataRepository;
      registry?: CommunicationChannelRegistry;
      fetch?: typeof fetch;
    },
  ) {}

  async authenticate(bearer: string): Promise<void> {
    await this.dependencies.authenticate(bearer);
  }

  private get registry() {
    return this.dependencies.registry ?? getActiveCommunicationChannelRegistry();
  }
  private get repository() {
    return this.dependencies.repository ?? new DatabaseRepository();
  }

  private async channel(userId: string, channelId: string): Promise<Channel> {
    const adapter = this.registry.get(channelId);
    if (!adapter) throw new Error("channel_unavailable");
    const configuration = { get: <T>(key: string) => this.repository.getSetting<T>(userId, key) };
    if (channelId === "telegram" && adapter.provider === "telegram") {
      const [enabled, token, recipient] = await Promise.all([
        configuration.get<boolean>("telegram.enabled"),
        configuration.get<string>("telegram.bot_token"),
        configuration.get<string>("telegram.chat_id"),
      ]);
      if (enabled === false || !token || !/^\d+:[A-Za-z0-9_-]+$/.test(token) || !recipient)
        throw new Error("channel_unavailable");
      return {
        kind: "telegram",
        token,
        recipient,
        public: {
          channelId,
          provider: "telegram",
          authorityDigest: this.digest({ channelId, token, recipient }),
        },
      };
    }
    if (!(adapter instanceof ExtensionCommunicationChannelAdapter))
      throw new Error("channel_unsupported");
    const resolved = await adapter.resolveBinaryConfiguration(configuration);
    const artifact = await adapter.ownerBinaryArtifact();
    return {
      kind: "extension",
      adapter,
      configuration: resolved,
      public: {
        channelId,
        provider: "extension",
        bundleDigest: artifact.digest,
        settings: resolved.settings,
        authorityDigest: this.digest({
          channelId,
          configuration: resolved,
          bundleDigest: artifact.digest,
        }),
      },
    };
  }

  private digest(input: unknown) {
    return createHash("sha256").update(canonicalJson(input)).digest("hex");
  }

  private async frame(userId: string, frame: CommunicationOwnerPrepare["workflowFrame"]) {
    if (!frame) return;
    const current = await this.repository.getExecution(frame.executionId);
    if (
      !current ||
      current.userId !== userId ||
      current.workflowId !== frame.workflowId ||
      current.revision !== frame.revision ||
      metadataRevision(current.taskIdentity ?? null) !== frame.taskIdentityRevision
    )
      throw new Error("workflow_frame_changed");
  }

  async prepare(bearer: string, value: unknown) {
    const input = communicationOwnerPrepareSchema.parse(value);
    const userId = await this.dependencies.authorize(bearer, input.scope);
    await this.frame(userId, input.workflowFrame);
    const ids = input.channelIds ?? this.registry.list().map((adapter) => adapter.id);
    const channels: CommunicationOwnerChannel[] = [];
    for (const id of new Set(ids)) {
      try {
        const adapter = this.registry.get(id);
        if (!adapter || !adapter.capabilities[input.kind]) continue;
        const channel = await this.channel(userId, id);
        if (channel.kind === "telegram") this.telegramFile(input);
        channels.push(channel.public);
      } catch (error) {
        if (
          input.channelIds ||
          !(error instanceof Error) ||
          !["channel_unavailable", "configuration_changed"].includes(error.message)
        )
          throw new Error("channel_unavailable");
      }
    }
    // Configuration resolution yields. Revocation cannot hand a stale actor a new descriptor.
    await this.dependencies.authorize(bearer, input.scope);
    await this.frame(userId, input.workflowFrame);
    return { channels };
  }

  async artifact(
    bearer: string,
    scope: CommunicationOwnerScope,
    channelId: string,
    digest: string,
  ) {
    const userId = await this.dependencies.authorize(bearer, scope);
    const channel = await this.channel(userId, channelId);
    if (channel.kind !== "extension" || channel.public.bundleDigest !== digest)
      throw new Error("channel_changed");
    const artifact = await channel.adapter.ownerBinaryArtifact();
    await this.dependencies.authorize(bearer, scope);
    if (artifact.digest !== digest) throw new Error("channel_changed");
    return artifact.bytes;
  }

  async send(
    bearer: string,
    value: unknown,
    source: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<CommunicationVendorResult> {
    let dispatched = false;
    let complete = false;
    let body: AsyncGenerator<Uint8Array> | undefined;
    const outbound = new AbortController();
    const abort = () => outbound.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const input = communicationOwnerSendSchema.parse(value);
      const userId = await this.dependencies.authorize(bearer, input.scope);
      const channel = await this.channel(userId, input.channelId);
      if (
        channel.public.authorityDigest !== input.authorityDigest ||
        channel.public.bundleDigest !== input.bundleDigest
      )
        return { status: "refused", reason: "channel_changed" };
      const plan = this.plan(channel, input);
      await this.dependencies.authorize(bearer, input.scope);
      await this.frame(userId, input.workflowFrame);
      signal?.throwIfAborted();
      const authority = this.dependencies.authorize;
      body = (async function* () {
        if (plan.prefix) yield plan.prefix;
        for await (const bytes of source) {
          signal?.throwIfAborted();
          await authority(bearer, input.scope);
          yield bytes;
        }
        complete = true;
        if (plan.suffix) yield plan.suffix;
      })();
      dispatched = true;
      const response = await fetchWork(
        plan.url,
        {
          method: plan.method,
          headers: plan.headers,
          body: body as unknown as BodyInit,
          duplex: "half",
          redirect: "error",
          signal: outbound.signal,
        } as RequestInit & { duplex: "half" },
        this.dependencies.fetch,
      );
      if (channel.kind === "telegram") {
        const result = (await response.json()) as { ok?: unknown };
        if (!response.ok || result.ok !== true)
          return {
            status: response.status >= 500 ? "unconfirmed" : "refused",
            reason: "provider_rejected",
          };
      } else {
        // Consume only the vendor's response metadata, never the file source into cloud storage.
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (!(await reader.read()).done) {
              /* Drain to physical response completion. */
            }
          } finally {
            reader.releaseLock();
          }
        }
        if (!response.ok)
          return {
            status: response.status >= 500 ? "unconfirmed" : "refused",
            reason: "provider_rejected",
          };
      }
      return complete
        ? { status: "delivered" }
        : { status: "unconfirmed", reason: "source_incomplete" };
    } catch {
      return {
        status: dispatched ? "unconfirmed" : "refused",
        reason: dispatched ? "provider_outcome_unconfirmed" : "delivery_not_admitted",
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      outbound.abort();
      // A vendor can finish before consuming its request. Interrupt an outstanding
      // IncomingMessage read before asking its generator to return; otherwise
      // return() queues behind that read and the accepted owner operation hangs.
      if (body && !complete && source instanceof Readable) {
        const closed = finished(source, { cleanup: true }).catch(() => {});
        source.destroy();
        await closed;
      }
      await body?.return(undefined);
    }
  }

  private plan(channel: Channel, input: CommunicationOwnerSend) {
    let url: string,
      method: "POST" | "PUT" = "POST";
    const headers: Record<string, string> = {};
    let fields: Record<string, string>;
    let fileField: string | null;
    if (channel.kind === "telegram") {
      if (input.controls || (input.operationId && input.operationId !== "send_message"))
        throw new Error("invalid_controls");
      if (input.operationId === "send_message") {
        if (input.file.size !== 0 || !input.text || input.text.length > TELEGRAM_TEXT_MAX_LENGTH)
          throw new Error("invalid_text_stage");
        const payload: Record<string, unknown> = {
          chat_id: channel.recipient,
          text: input.text,
          disable_notification: input.silent ?? false,
          link_preview_options: { is_disabled: true },
        };
        if (input.format === "markdown") payload.parse_mode = "Markdown";
        if (input.format === "html") payload.parse_mode = "HTML";
        const prefix = Buffer.from(JSON.stringify(payload));
        return {
          url: `https://api.telegram.org/bot${channel.token}/sendMessage`,
          method,
          headers: {
            "content-type": "application/json",
            "content-length": String(prefix.byteLength),
          },
          prefix,
          suffix: null,
        };
      }
      this.telegramFile(input);
      if (input.text.length > TELEGRAM_CAPTION_MAX_LENGTH)
        throw new Error("provider_attachment_limit");
      url = `https://api.telegram.org/bot${channel.token}/${input.kind === "image" ? "sendPhoto" : "sendDocument"}`;
      fields = { chat_id: channel.recipient };
      if (input.text) fields.caption = input.text;
      if (input.format === "markdown") fields.parse_mode = "Markdown";
      if (input.format === "html") fields.parse_mode = "HTML";
      if (input.silent !== undefined) fields.disable_notification = String(input.silent);
      fileField = input.kind === "image" ? "photo" : "document";
    } else {
      const operation = channel.configuration.declaration.binaryTransport!.operations.find(
        (candidate) => candidate.id === input.operationId,
      );
      if (!operation) throw new Error("operation_unavailable");
      const controls = binaryControlsSchema.parse(input.controls ?? {});
      const endpoint = operation.endpoint;
      const target =
        "url" in endpoint
          ? new URL(endpoint.url)
          : new URL(
              endpoint.path,
              String(channel.configuration.settings[endpoint.baseUrlSetting] ?? ""),
            );
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        target.hash ||
        !channel.configuration.declaration.permissions?.network?.includes(target.host)
      )
        throw new Error("endpoint_refused");
      url = target.href;
      method = operation.method;
      const secret = channel.configuration.secrets[operation.credential.secret];
      const recipient = channel.configuration.settings[operation.recipient.setting];
      if (!secret || typeof recipient !== "string" || !recipient)
        throw new Error("configuration_changed");
      headers[operation.credential.header] =
        `${operation.credential.scheme ? operation.credential.scheme + " " : ""}${secret}`;
      fields = { [operation.recipient.field]: recipient };
      if (operation.body.mode === "raw") {
        // Raw declarations place their sole fixed destination in a header, never a caller query.
        headers[operation.recipient.field] = recipient;
        fileField = null;
      } else {
        fileField = operation.body.fileField;
        for (const key of ["caption", "format", "silent"] as const) {
          const name = operation.body.controls?.[key];
          if (name && controls[key] !== undefined) fields[name] = String(controls[key]);
        }
      }
    }
    if (!fileField) {
      headers["content-type"] = input.file.mimeType;
      headers["content-length"] = String(input.file.size);
      return { url, method, headers, prefix: null, suffix: null };
    }
    const boundary = `moira-${randomBytes(24).toString("hex")}`;
    const prefix = Buffer.from(
      Object.entries(fields)
        .map(
          ([name, value]) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        )
        .join("") +
        `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${input.file.fileName.replaceAll('"', '\\"')}"\r\nContent-Type: ${input.file.mimeType}\r\n\r\n`,
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    headers["content-type"] = `multipart/form-data; boundary=${boundary}`;
    headers["content-length"] = String(prefix.byteLength + input.file.size + suffix.byteLength);
    return { url, method, headers, prefix, suffix };
  }

  private telegramFile(input: CommunicationOwnerPrepare) {
    if (input.kind === "image" && !["image/png", "image/jpeg"].includes(input.file.mimeType))
      throw new Error("invalid_image_type");
    // Actual Telegram upload constraints apply before owner admission and again before dispatch.
    const maximum = input.kind === "image" ? TELEGRAM_PHOTO_MAX_BYTES : TELEGRAM_DOCUMENT_MAX_BYTES;
    if (
      input.file.size <= 0 ||
      input.file.size > maximum ||
      input.text.length > TELEGRAM_TEXT_MAX_LENGTH
    )
      throw new Error("provider_attachment_limit");
  }
}
