import { getTelegramClient } from "./telegram-client-factory.js";
import type {
  CommunicationChannelAdapter,
  CommunicationConfigurationResolver,
  PortableCommunicationMessage,
} from "./user-communication.js";
import { CommunicationChannelError } from "./user-communication.js";

export class TelegramCommunicationAdapter implements CommunicationChannelAdapter {
  readonly id = "telegram";
  readonly provider = "telegram";
  readonly capabilities = { text: true, image: true, document: true, trusted: false } as const;
  readonly metadata = {
    title: "Telegram",
    description: "Messages delivered through your configured Telegram bot and chat.",
    origin: "builtin",
    settingKeys: ["telegram.enabled", "telegram.bot_token", "telegram.chat_id"],
    enabledSetting: "telegram.enabled",
    helpUrl: "/docs/integration/telegram-setup/",
  } as const;

  async isConfigured(
    configuration: CommunicationConfigurationResolver,
    _signal: AbortSignal,
  ): Promise<boolean> {
    const enabled = await configuration.get<boolean>("telegram.enabled");
    if (enabled === false) return false;
    const [token, chatId] = await Promise.all([
      configuration.get<string>("telegram.bot_token"),
      configuration.get<string>("telegram.chat_id"),
    ]);
    return Boolean(token && chatId);
  }

  async deliver(
    request: PortableCommunicationMessage,
    configuration: CommunicationConfigurationResolver,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (signal.aborted) throw new CommunicationChannelError("cancelled");
      const [token, chatId] = await Promise.all([
        configuration.get<string>("telegram.bot_token"),
        configuration.get<string>("telegram.chat_id"),
      ]);
      if (!token || !chatId) throw new CommunicationChannelError("configuration_changed");
      const client = getTelegramClient(token, chatId);
      if (!client) throw new CommunicationChannelError("provider_unavailable");
      const parseMode =
        request.format === "markdown" ? "Markdown" : request.format === "html" ? "HTML" : undefined;
      if (request.attachment?.kind === "image") {
        if (
          request.attachment.mimeType !== "image/png" &&
          request.attachment.mimeType !== "image/jpeg"
        )
          throw new CommunicationChannelError("invalid_attachment_type");
        const caption = request.text.length <= 1024 ? request.text || undefined : undefined;
        await client.sendPhoto({
          chatId,
          photo: request.attachment.bytes,
          filename: request.attachment.filename,
          mimeType: request.attachment.mimeType,
          caption,
          parseMode,
          disableNotification: request.silent,
        });
        if (!caption && request.text)
          await client.sendMessage({
            chatId,
            text: request.text,
            parseMode,
            disableNotification: request.silent,
          });
        return;
      }
      if (request.attachment?.kind === "document") {
        const caption = request.text.length <= 1024 ? request.text || undefined : undefined;
        await client.sendDocument({
          chatId,
          document: request.attachment.bytes,
          filename: request.attachment.filename,
          mimeType: request.attachment.mimeType,
          caption,
          parseMode,
          disableNotification: request.silent,
        });
        if (!caption && request.text)
          await client.sendMessage({
            chatId,
            text: request.text,
            parseMode,
            disableNotification: request.silent,
          });
        return;
      }
      await client.sendMessage({
        chatId,
        text: request.text,
        parseMode,
        disableNotification: request.silent,
      });
    } catch (error) {
      if (error instanceof CommunicationChannelError) throw error;
      const providerReason =
        error && typeof error === "object" && "type" in error && typeof error.type === "string"
          ? error.type
          : "provider_error";
      throw new CommunicationChannelError(providerReason);
    }
  }
}
