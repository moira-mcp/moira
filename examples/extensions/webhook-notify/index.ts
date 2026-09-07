import { defineChannel, defineExtension, defineNode } from "@mcp-moira/extension-sdk";

const TOKEN = "webhook-notify.token";
const BASE_URL = "webhook-notify.base_url";
const MESSAGE_PATH = "webhook-notify.message_path";
const AUTH_SCHEME = "webhook-notify.auth_scheme";
const ENABLED = "webhook-notify.enabled";
const DEFAULT_RECIPIENT = "webhook-notify.default_recipient";

function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const until = Date.parse(value);
  if (Number.isNaN(until)) return null;
  return Math.max(0, Math.round((until - Date.now()) / 1000));
}

async function sendToWebhook(
  options: {
    token: string;
    baseUrl: string;
    messagePath: string | null;
    authScheme: string | null;
    body: Record<string, string>;
  },
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<string> {
  const url = `${options.baseUrl.replace(/\/+$/, "")}${options.messagePath ?? "/api/v1/messages"}`;
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      authorization: `${options.authScheme ?? "Bearer"} ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(options.body),
  });

  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
    throw new Error(
      retryAfter === null
        ? "rate limited by the endpoint; it gave no retry delay"
        : `rate limited by the endpoint; retry after ${retryAfter} s`,
    );
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `the endpoint refused the message with status ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  const payload = (await response.json()) as { message_id?: number | string };
  if (payload.message_id === undefined || payload.message_id === null) {
    throw new Error("the endpoint accepted the message but returned no message id");
  }
  return String(payload.message_id);
}

const postMessage = defineNode({
  type: "webhook-notify.post-message",
  async handler({ config, services }) {
    const recipients = [
      { field: "channel", value: config.channel },
      { field: "recipient", value: config.recipient },
    ].filter(
      (candidate): candidate is { field: string; value: string } =>
        typeof candidate.value === "string" && candidate.value.length > 0,
    );

    if (recipients.length !== 1) {
      throw new Error(
        recipients.length === 0
          ? "no recipient: set exactly one of channel or recipient"
          : "more than one recipient: set exactly one of channel or recipient",
      );
    }

    const [token, baseUrl, messagePath, authScheme] = await Promise.all([
      services.secret(TOKEN),
      services.secret(BASE_URL),
      services.secret(MESSAGE_PATH),
      services.secret(AUTH_SCHEME),
    ]);
    if (!token) throw new Error(`setting '${TOKEN}' is not set`);
    if (!baseUrl) throw new Error(`setting '${BASE_URL}' is not set`);

    const recipient = recipients[0]!;
    const body: Record<string, string> = {
      text: String(config.text),
      [recipient.field]: recipient.value,
    };
    if (typeof config.threadId === "string") body.thread_id = config.threadId;

    services.log("posting a message to the configured endpoint", {
      recipientField: recipient.field,
      hasThread: typeof config.threadId === "string",
    });
    const messageId = await sendToWebhook(
      { token, baseUrl, messagePath, authScheme, body },
      services.fetch,
    );
    return { messageId };
  },
});

const notifications = defineChannel({
  id: "webhook-notify.notifications",
  async handler({ message, settings, services }) {
    if (settings[ENABLED] !== true) throw new Error("notification channel is disabled");
    const token = await services.secret(TOKEN);
    const baseUrl = settings[BASE_URL];
    const destination = settings[DEFAULT_RECIPIENT];
    if (!token || typeof baseUrl !== "string" || typeof destination !== "string") {
      throw new Error("notification channel configuration is incomplete");
    }
    await sendToWebhook(
      {
        token,
        baseUrl,
        messagePath: typeof settings[MESSAGE_PATH] === "string" ? settings[MESSAGE_PATH] : null,
        authScheme: typeof settings[AUTH_SCHEME] === "string" ? settings[AUTH_SCHEME] : null,
        body: { text: message.text, channel: destination },
      },
      services.fetch,
    );
  },
});

export default defineExtension({ nodes: [postMessage], communicationChannels: [notifications] });
