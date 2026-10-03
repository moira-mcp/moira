import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "@jest/globals";
import { createServer as httpServer } from "node:http";
import { createServer as smtpServer, type AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { github } from "better-auth/social-providers";
import { APIError } from "better-auth/api";
import type { SuccessfulRegistration } from "@mcp-moira/shared";
import type { UserCommunicationResult } from "@mcp-moira/workflow-engine";
import { createTestOriginFetch } from "../utils/test-origin-fetch.js";

type SharedRuntime = typeof import("@mcp-moira/shared");
type EngineRuntime = typeof import("@mcp-moira/workflow-engine");
let createAuth: SharedRuntime["createAuth"];
let createLogger: SharedRuntime["createLogger"];
let getAuthUrl: SharedRuntime["getAuthUrl"];
let getBaseUrl: SharedRuntime["getBaseUrl"];
let getAppPrefix: SharedRuntime["getAppPrefix"];
let getDatabase: SharedRuntime["getDatabase"];
let closeDatabase: SharedRuntime["closeDatabase"];
let user: SharedRuntime["user"];
let emailLog: SharedRuntime["emailLog"];
let globalSetting: SharedRuntime["globalSetting"];
let auditLog: SharedRuntime["auditLog"];
let oauthApplication: SharedRuntime["oauthApplication"];
let resetFeatureResolver: SharedRuntime["resetFeatureResolver"];
let DatabaseRepository: EngineRuntime["DatabaseRepository"];
let TelegramClient: EngineRuntime["TelegramClient"];
let notifyAdminsOfRegistration: EngineRuntime["notifyAdminsOfRegistration"];
let resetClientFactory: EngineRuntime["resetClientFactory"];
let setTestClientFactory: EngineRuntime["setTestClientFactory"];
let getActiveUserCommunicationService: EngineRuntime["getActiveUserCommunicationService"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const originalFetch = globalThis.fetch;
const envKeys = [
  "DEPLOYMENT_MODE",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "EMAIL_FROM_NAME",
  "EMAIL_TEST_RECIPIENTS",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_REQUIRE_TLS",
  "SMTP_USER",
  "SMTP_PASSWORD",
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const fixtureId = randomUUID();
const recipientId = `registration-receiver-${fixtureId}`;
const createdEmails: string[] = [];
const createdClients: string[] = [];
const smtpMessages: string[] = [];
const telegramMessages: Array<{ chat_id: string; text: string; parse_mode?: string }> = [];
const events: SuccessfulRegistration[] = [];
const exchanges: URLSearchParams[] = [];
const notificationTasks: Promise<void>[] = [];
const deliveries: Array<{ userId: string; result: UserCommunicationResult | null }> = [];
let rejectMail = false;
let providerEmail = "";
let providerId = "";
let holdTelegram = false;
let telegramFailure: "none" | "refuse" | "ambiguous" = "none";
let received = deferred<{ message: (typeof telegramMessages)[number]; reply: () => void }>();
let originalPreference: string | null;
let providerUrl: string;
let auth: ReturnType<typeof createAuth>;
const restoreHooks: Array<() => void> = [];

const transport = httpServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/github/token") {
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      exchanges.push(body);
      response.end(
        JSON.stringify({
          access_token: "fixture-access-token",
          token_type: "bearer",
          scope: "read:user user:email",
        }),
      );
    } else if (request.url === "/github/user") {
      response.end(
        JSON.stringify({
          id: providerId,
          email: providerEmail,
          name: "OAuth Reader",
          login: "fixture-reader",
        }),
      );
    } else if (request.url === "/github/emails") {
      response.end(JSON.stringify([{ email: providerEmail, primary: true, verified: true }]));
    } else if (request.url?.endsWith("/sendMessage")) {
      const message = JSON.parse(
        Buffer.concat(chunks).toString(),
      ) as (typeof telegramMessages)[number];
      telegramMessages.push(message);
      const reply = () => {
        if (!response.writableEnded && !response.destroyed)
          response.end(
            JSON.stringify({
              ok: true,
              result: {
                message_id: telegramMessages.length,
                date: 1,
                chat: { id: 123, type: "private" },
                text: message.text,
              },
            }),
          );
      };
      received.resolve({ message, reply });
      if (telegramFailure === "refuse") {
        response.statusCode = 503;
        response.end(
          JSON.stringify({ ok: false, error_code: 503, description: "Fixture refused delivery" }),
        );
      } else if (telegramFailure === "ambiguous") response.destroy();
      else if (!holdTelegram) reply();
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "unexpected fixture request" }));
    }
  });
});
const mail = smtpServer((socket) => {
  socket.setEncoding("utf8");
  socket.write("220 registration fixture ESMTP\r\n");
  let buffer = "";
  let message = "";
  let readingData = false;
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\r\n")) {
      const end = buffer.indexOf("\r\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (readingData) {
        if (line === ".") {
          readingData = false;
          smtpMessages.push(message);
          socket.write("250 queued\r\n");
        } else message += `${line}\n`;
      } else if (/^(EHLO|HELO) /.test(line)) socket.write("250-fixture\r\n250 8BITMIME\r\n");
      else if (/^RCPT TO:/i.test(line) && rejectMail)
        socket.write("550 fixture rejected recipient\r\n");
      else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write("250 OK\r\n");
      else if (line === "DATA") {
        readingData = true;
        socket.write("354 End data\r\n");
      } else if (line === "QUIT") socket.end("221 Bye\r\n");
      else if (line === "RSET") {
        message = "";
        socket.write("250 reset\r\n");
      }
    }
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    transport.once("error", reject);
    transport.listen(0, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    mail.once("error", reject);
    mail.listen(0, "127.0.0.1", resolve);
  });
  providerUrl = `http://127.0.0.1:${(transport.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    DEPLOYMENT_MODE: "saas",
    EMAIL_PROVIDER: "smtp",
    EMAIL_FROM: "sender@registration.test",
    EMAIL_FROM_NAME: "Registration fixture",
    EMAIL_TEST_RECIPIENTS: "false",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String((mail.address() as AddressInfo).port),
    SMTP_SECURE: "false",
    SMTP_REQUIRE_TLS: "false",
  });
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  // Jest setup already evaluates an engine graph. Evaluate this fixture's real graph only after
  // its deployment/mail configuration exists; do not overwrite the factory's computed options.
  await jest.isolateModulesAsync(async () => {
    ({
      createAuth,
      createLogger,
      getAuthUrl,
      getBaseUrl,
      getAppPrefix,
      getDatabase,
      closeDatabase,
      user,
      emailLog,
      globalSetting,
      auditLog,
      oauthApplication,
      resetFeatureResolver,
    } = await import("@mcp-moira/shared"));
    ({
      DatabaseRepository,
      TelegramClient,
      notifyAdminsOfRegistration,
      resetClientFactory,
      setTestClientFactory,
      getActiveUserCommunicationService,
    } = await import("@mcp-moira/workflow-engine"));
  });
  resetFeatureResolver();
  await getDatabase()
    .insert(user)
    .values({
      id: recipientId,
      email: `receiver-${fixtureId}@registration.test`,
      name: "Admitted receiver",
      handle: `receiver-${fixtureId}`,
      isAdmin: true,
      blocked: false,
      emailVerified: true,
      approvedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  const repository = new DatabaseRepository();
  await repository.setSetting(recipientId, "telegram.enabled", true);
  await repository.setSetting(
    recipientId,
    "telegram.bot_token",
    "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  );
  await repository.setSetting(recipientId, "telegram.chat_id", "123");
  const [preference] = await getDatabase()
    .select()
    .from(globalSetting)
    .where(eq(globalSetting.key, "system.notify_admins_on_registration"));
  expect(preference).toBeDefined();
  originalPreference = preference.value;
  await getDatabase()
    .update(globalSetting)
    .set({ value: "true" })
    .where(eq(globalSetting.key, preference.key));
  setTestClientFactory((token, chatId) => {
    if (!token || !chatId)
      throw new Error("Registration fixture requires the configured bot and chat");
    return new TelegramClient({
      botToken: token,
      defaultChatId: chatId,
      apiUrl: `${providerUrl}/bot`,
    });
  });
});

beforeEach(async () => {
  events.length = 0;
  exchanges.length = 0;
  telegramMessages.length = 0;
  smtpMessages.length = 0;
  notificationTasks.length = 0;
  deliveries.length = 0;
  rejectMail = false;
  holdTelegram = false;
  telegramFailure = "none";
  received = deferred();
  providerEmail = `oauth-${randomUUID()}@registration.test`;
  providerId = randomUUID();
  const routes = new Map([
    ["https://github.com/login/oauth/access_token", "/github/token"],
    ["https://api.github.com/user", "/github/user"],
    ["https://api.github.com/user/emails", "/github/emails"],
  ]);
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = routes.get(url);
    if (path)
      return originalFetch(
        new Request(`${providerUrl}${path}`, input instanceof Request ? input : init),
      );
    if (new URL(url).hostname === "github.com" || new URL(url).hostname === "api.github.com")
      throw new Error("Unexpected OAuth provider URL");
    return originalFetch(input, init);
  };
  auth = createAuth(createLogger({ component: "RegistrationIntegration" }), {
    onSuccessfulRegistration: (event) => {
      events.push(event);
      const task = notifyAdminsOfRegistration(event);
      notificationTasks.push(task);
      return task;
    },
  });
  const context = await auth.$context;
  expect(context.options.emailVerification?.sendOnSignUp).toBe(true);
  context.socialProviders = [
    github({ clientId: "fixture-client", clientSecret: "fixture-secret" }),
  ];
  const communication = getActiveUserCommunicationService();
  const deliver = communication.deliverChannel.bind(communication);
  jest.spyOn(communication, "deliverChannel").mockImplementation(async (...args) => {
    const result = await deliver(...args);
    deliveries.push({ userId: args[1].userId, result });
    return result;
  });
});
afterEach(async () => {
  holdTelegram = false;
  if (telegramMessages.length) (await received.promise).reply();
  await Promise.allSettled(notificationTasks);
  restoreHooks
    .splice(0)
    .reverse()
    .forEach((restore) => restore());
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});
afterAll(async () => {
  resetClientFactory();
  await getDatabase()
    .update(globalSetting)
    .set({ value: originalPreference })
    .where(eq(globalSetting.key, "system.notify_admins_on_registration"));
  const accounts = await getDatabase()
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.email, createdEmails));
  const ids = [...accounts.map((account) => account.id), recipientId];
  await getDatabase().delete(auditLog).where(inArray(auditLog.userId, ids));
  await getDatabase().delete(user).where(inArray(user.id, ids));
  if (createdClients.length)
    await getDatabase()
      .delete(oauthApplication)
      .where(inArray(oauthApplication.clientId, createdClients));
  await new Promise<void>((resolve, reject) =>
    transport.close((error) => (error ? reject(error) : resolve())),
  );
  await new Promise<void>((resolve, reject) =>
    mail.close((error) => (error ? reject(error) : resolve())),
  );
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetFeatureResolver();
  closeDatabase();
});

function call(path: string, body?: unknown, cookie?: string) {
  const handlerFetch = createTestOriginFetch(
    (input, init) => auth.handler(new Request(input, init)),
    () => new URL(getAuthUrl()).origin,
  );
  return handlerFetch(`${getAuthUrl()}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function signup(email = `email-${randomUUID()}@registration.test`, cookie?: string) {
  createdEmails.push(email);
  return call(
    "/sign-up/email",
    {
      name: "Literal *Name* <b>plain</b>",
      email,
      password: "RegistrationPassword123!",
      acceptedTermsAt: new Date().toISOString(),
      acceptedNotRussianResidentAt: new Date().toISOString(),
    },
    cookie,
  );
}
function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
async function oauth(extraCookie?: string) {
  createdEmails.push(providerEmail);
  const started = await call("/sign-in/social", {
    provider: "github",
    callbackURL: `${getBaseUrl()}${getAppPrefix()}/workflows`,
    disableRedirect: true,
  });
  expect(started.status).toBe(200);
  const state = new URL((await started.json()).url).searchParams.get("state")!;
  return call(
    `/callback/github?code=fixture-oauth-code&state=${encodeURIComponent(state)}`,
    undefined,
    [cookies(started), extraCookie].filter(Boolean).join("; "),
  );
}
async function assertDelivery(accountId: string) {
  await Promise.all(notificationTasks);
  expect(events).toHaveLength(1);
  const [account] = await getDatabase().select().from(user).where(eq(user.id, accountId));
  expect(events[0]).toEqual({
    id: account.id,
    name: account.name,
    email: account.email,
    createdAt: Date.parse(account.createdAt),
  });
  expect(telegramMessages).toHaveLength(1);
  expect(deliveries.find((delivery) => delivery.userId === recipientId)?.result).toMatchObject({
    status: "delivered",
    deliveredChannels: 1,
    channels: [{ channelId: "telegram", status: "delivered" }],
  });
  expect(telegramMessages[0]).toMatchObject({ chat_id: "123" });
  expect(telegramMessages[0]).not.toHaveProperty("parse_mode");
  expect(telegramMessages[0].text).toContain(account.name!);
  expect(telegramMessages[0].text).toContain(account.email);
  expect(telegramMessages[0].text).toContain(new Date(events[0].createdAt).toISOString());
  expect(telegramMessages[0].text).toContain(
    `${getBaseUrl()}${getAppPrefix()}/admin/users/${encodeURIComponent(accountId)}`,
  );
}

test("successful email registration delivers one real Telegram message after real SMTP without waiting for Telegram acknowledgement", async () => {
  holdTelegram = true;
  let returned = false;
  const operation = signup().then((response) => {
    returned = true;
    return response;
  });
  await Promise.race([operation, received.promise]);
  expect(returned).toBe(true);
  const response = await operation;
  expect(response.status).toBe(200);
  expect(events).toHaveLength(1);
  const accountId = (await response.clone().json()).user.id as string;
  const accepted = await received.promise;
  accepted.reply();
  await assertDelivery(accountId);
  expect(smtpMessages).toHaveLength(1);
  expect(smtpMessages[0]).toContain(events[0].email);
  const emails = await getDatabase().select().from(emailLog).where(eq(emailLog.userId, accountId));
  expect(emails).toMatchObject([{ status: "sent", type: "verification" }]);
  const observed = await auth.api.getSession({
    headers: new Headers({ Cookie: cookies(response) }),
  });
  expect(observed?.user.id).toBe(accountId);
});

test("first real OAuth callback delivers once and repeat provider login does not emit a new registration", async () => {
  const response = await oauth();
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${getBaseUrl()}${getAppPrefix()}/workflows`);
  const observed = await auth.api.getSession({
    headers: new Headers({ Cookie: cookies(response) }),
  });
  expect(observed?.user.id).toBeTruthy();
  await assertDelivery(observed!.user.id);
  expect(exchanges).toHaveLength(1);
  expect(exchanges[0].get("code")).toBe("fixture-oauth-code");
  expect(exchanges[0].get("code_verifier")).toBeTruthy();
  const repeated = await oauth();
  expect(repeated.status).toBe(302);
  await Promise.all(notificationTasks);
  expect(events).toHaveLength(1);
  expect(telegramMessages).toHaveLength(1);
});

test("overlapping real registrations each deliver only their own persisted identity", async () => {
  const hooks = (await auth.$context).options.databaseHooks!;
  const previous = hooks.user!.create!.after;
  const arrived: string[] = [];
  const bothCreated = deferred<void>();
  hooks.user!.create!.after = async (account, context) => {
    await previous?.(account, context);
    arrived.push(account.id);
    if (arrived.length === 2) bothCreated.resolve();
    await bothCreated.promise;
  };
  restoreHooks.push(() => {
    hooks.user!.create!.after = previous;
  });
  const responses = await Promise.all([signup(), signup()]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const ids = await Promise.all(
    responses.map(async (response) => (await response.json()).user.id as string),
  );
  expect(new Set(arrived)).toEqual(new Set(ids));
  await Promise.all(notificationTasks);
  expect(events).toHaveLength(2);
  expect(telegramMessages).toHaveLength(2);
  expect(
    deliveries
      .filter((delivery) => delivery.userId === recipientId)
      .map((delivery) => delivery.result),
  ).toMatchObject([
    { status: "delivered", deliveredChannels: 1 },
    { status: "delivered", deliveredChannels: 1 },
  ]);
  for (const id of ids) {
    const [account] = await getDatabase().select().from(user).where(eq(user.id, id));
    expect(events.find((event) => event.id === id)).toEqual({
      id,
      name: account.name,
      email: account.email,
      createdAt: Date.parse(account.createdAt),
    });
    expect(telegramMessages.filter((message) => message.text.includes(account.email))).toHaveLength(
      1,
    );
  }
});

test("existing email login and provider linking are not registrations", async () => {
  const created = await signup();
  expect(created.status).toBe(200);
  const account = (await created.json()).user as { id: string; email: string };
  await assertDelivery(account.id);
  await getDatabase().update(user).set({ emailVerified: true }).where(eq(user.id, account.id));
  const signedIn = await call("/sign-in/email", {
    email: account.email,
    password: "RegistrationPassword123!",
  });
  expect(signedIn.status).toBe(200);
  providerEmail = account.email;
  const linked = await oauth();
  expect(linked.status).toBe(302);
  const observed = await auth.api.getSession({ headers: new Headers({ Cookie: cookies(linked) }) });
  expect(observed?.user.id).toBe(account.id);
  const duplicate = await signup(account.email);
  expect(duplicate.status).toBeGreaterThanOrEqual(400);
  await Promise.all(notificationTasks);
  expect(events).toHaveLength(1);
  expect(telegramMessages).toHaveLength(1);
});

test("invalid OAuth state and failed OAuth account creation cannot publish a registration", async () => {
  const invalid = await call(
    "/callback/github?code=fixture-oauth-code&state=missing-fixture-state",
  );
  expect(invalid.status).toBe(302);
  expect(new URL(invalid.headers.get("location")!, getAuthUrl()).searchParams.has("error")).toBe(
    true,
  );
  const hooks = (await auth.$context).options.databaseHooks!;
  const previous = hooks.account;
  hooks.account = {
    create: {
      before: async () => {
        throw new APIError("BAD_REQUEST", { message: "Fixture refused OAuth account" });
      },
    },
  };
  restoreHooks.push(() => {
    hooks.account = previous;
  });
  const refused = await oauth();
  expect(refused.status).toBe(302);
  expect(new URL(refused.headers.get("location")!, getAuthUrl()).searchParams.has("error")).toBe(
    true,
  );
  expect(await getDatabase().select().from(user).where(eq(user.email, providerEmail))).toHaveLength(
    1,
  );
  await Promise.all(notificationTasks);
  expect(events).toEqual([]);
  expect(telegramMessages).toEqual([]);
});

test.each(["throw", "reject"] as const)(
  "notification callback %s leaves successful registration and session intact without retry",
  async (failure) => {
    let attempts = 0;
    auth = createAuth(createLogger({ component: "RegistrationCallbackFailure" }), {
      onSuccessfulRegistration: () => {
        attempts++;
        if (failure === "throw") throw new Error("Fixture callback throw");
        return Promise.reject(new Error("Fixture callback rejection"));
      },
    });
    expect((await auth.$context).options.emailVerification?.sendOnSignUp).toBe(true);
    const response = await signup();
    expect(response.status).toBe(200);
    const accountId = (await response.json()).user.id as string;
    const observed = await auth.api.getSession({
      headers: new Headers({ Cookie: cookies(response) }),
    });
    expect(observed?.user.id).toBe(accountId);
    expect(attempts).toBe(1);
  },
);

test.each(["user", "account", "session", "mail"] as const)(
  "%s failure cannot notify even when a candidate survives or verification error is swallowed",
  async (stage) => {
    const context = await auth.$context;
    const hooks = context.options.databaseHooks!;
    if (stage === "mail") rejectMail = true;
    else if (stage === "user") {
      const previous = hooks.user!.create!.before;
      hooks.user!.create!.before = async () => {
        throw new APIError("BAD_REQUEST", { message: "Fixture rejected user" });
      };
      restoreHooks.push(() => {
        hooks.user!.create!.before = previous;
      });
    } else if (stage === "account") {
      const previous = hooks.account;
      hooks.account = {
        create: {
          before: async () => {
            throw new APIError("BAD_REQUEST", { message: "Fixture rejected credential" });
          },
        },
      };
      restoreHooks.push(() => {
        hooks.account = previous;
      });
    } else {
      const previous = hooks.session!.create!.before;
      hooks.session!.create!.before = async () => {
        throw new APIError("BAD_REQUEST", { message: "Fixture rejected session" });
      };
      restoreHooks.push(() => {
        hooks.session!.create!.before = previous;
      });
    }
    const email = `failed-${randomUUID()}@registration.test`;
    const response = await signup(email);
    if (stage === "mail") expect(response.status).toBe(200);
    else expect(response.status).toBeGreaterThanOrEqual(400);
    await Promise.all(notificationTasks);
    expect(events).toEqual([]);
    expect(telegramMessages).toEqual([]);
    const accounts = await getDatabase().select().from(user).where(eq(user.email, email));
    expect(accounts).toHaveLength(stage === "user" ? 0 : 1);
    if (stage === "mail")
      expect(
        await getDatabase().select().from(emailLog).where(eq(emailLog.userId, accounts[0].id)),
      ).toMatchObject([{ status: "failed" }]);
  },
);

test("actual late MCP after-hook APIError with retained OAuth HTTP 302 and issued session does not notify", async () => {
  const registered = await call("/mcp/register", {
    client_name: "Registration failure fixture",
    redirect_uris: [`${getBaseUrl()}/accepted-fixture-callback`],
  });
  expect(registered.status).toBe(201);
  const clientId = (await registered.json()).client_id as string;
  createdClients.push(clientId);
  const prompt = await call(
    `/mcp/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&redirect_uri=${encodeURIComponent(`${getBaseUrl()}/refused-fixture-callback`)}`,
  );
  expect(prompt.status).toBe(302);
  const response = await oauth(cookies(prompt));
  expect(response.status).toBe(302);
  expect(await response.clone().json()).toMatchObject({ message: "Invalid redirect URI" });
  const observed = await auth.api.getSession({
    headers: new Headers({ Cookie: cookies(response) }),
  });
  expect(observed?.user.email).toBe(providerEmail);
  expect(await getDatabase().select().from(user).where(eq(user.email, providerEmail))).toHaveLength(
    1,
  );
  await Promise.all(notificationTasks);
  expect(events).toEqual([]);
  expect(telegramMessages).toEqual([]);
});

test("persisted false notification preference suppresses Telegram for a successful real registration", async () => {
  await getDatabase()
    .update(globalSetting)
    .set({ value: "false" })
    .where(eq(globalSetting.key, "system.notify_admins_on_registration"));
  try {
    const response = await signup();
    expect(response.status).toBe(200);
    await Promise.all(notificationTasks);
    expect(events).toHaveLength(1);
    expect(telegramMessages).toEqual([]);
    expect(deliveries).toEqual([]);
  } finally {
    await getDatabase()
      .update(globalSetting)
      .set({ value: "true" })
      .where(eq(globalSetting.key, "system.notify_admins_on_registration"));
  }
});

test.each(["refuse", "ambiguous"] as const)(
  "actual Telegram %s preserves registration/session, reports no delivery and does not retry",
  async (failure) => {
    telegramFailure = failure;
    const response = await signup();
    expect(response.status).toBe(200);
    const id = (await response.json()).user.id as string;
    await Promise.all(notificationTasks);
    const observed = await auth.api.getSession({
      headers: new Headers({ Cookie: cookies(response) }),
    });
    expect(observed?.user.id).toBe(id);
    expect(events).toHaveLength(1);
    expect(telegramMessages).toHaveLength(1);
    expect(deliveries.find((delivery) => delivery.userId === recipientId)?.result).toMatchObject({
      status: "all_failed",
      deliveredChannels: 0,
      channels: [{ channelId: "telegram", status: "failed" }],
    });
  },
);

test.each(["consent", "password"] as const)(
  "actual %s validation refuses registration without an event or Telegram request",
  async (failure) => {
    const email = `validation-${randomUUID()}@registration.test`;
    createdEmails.push(email);
    const response = await call("/sign-up/email", {
      name: "Rejected fixture",
      email,
      password: failure === "password" ? "x" : "RegistrationPassword123!",
      ...(failure === "consent"
        ? {}
        : {
            acceptedTermsAt: new Date().toISOString(),
            acceptedNotRussianResidentAt: new Date().toISOString(),
          }),
    });
    expect(response.status).toBe(400);
    expect(await getDatabase().select().from(user).where(eq(user.email, email))).toEqual([]);
    await Promise.all(notificationTasks);
    expect(events).toEqual([]);
    expect(telegramMessages).toEqual([]);
  },
);
