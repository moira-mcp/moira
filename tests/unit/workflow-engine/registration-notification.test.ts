import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import { GlobalSettingsRepository, UserRepository, resetFeatureResolver } from "@mcp-moira/shared";
import * as schema from "../../../packages/shared/src/database/schema.js";
import {
  InMemoryRepository,
  TelegramCommunicationAdapter,
  UserCommunicationService,
  notifyAdminsOfRegistration,
  REGISTRATION_NOTIFICATION_SETTING,
  resetClientFactory,
  type RegistrationNotificationDependencies,
} from "@mcp-moira/workflow-engine";

const originalMode = process.env.DEPLOYMENT_MODE;
let sqlite: Database.Database;
let settings: GlobalSettingsRepository;
let recipients: UserRepository;
let repository: InMemoryRepository;
let communication: UserCommunicationService;
let dependencies: RegistrationNotificationDependencies;
let accepted: Array<Record<string, unknown>>;
const event = {
  id: "new user/identity",
  name: "Alex *<name>*",
  email: "alex@example.test",
  createdAt: 0,
};

beforeEach(async () => {
  process.env.DEPLOYMENT_MODE = "self-host";
  resetFeatureResolver();
  resetClientFactory();
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "packages/web-backend/drizzle") });
  settings = new GlobalSettingsRepository(db);
  recipients = new UserRepository(db);
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,handle,isAdmin,blocked,emailVerified,approvedAt,createdAt,updatedAt) VALUES ('admin','Admin','admin@example.test','admin',1,0,1,'2026-01-01','2026-01-01','2026-01-01')",
    )
    .run();
  repository = new InMemoryRepository();
  for (const [key, type] of [
    ["telegram.enabled", "boolean"],
    ["telegram.bot_token", "string"],
    ["telegram.chat_id", "string"],
  ] as const) {
    await repository.createSettingDefinition({
      key,
      type,
      category: "notifications",
      label: key,
      description: null,
      defaultValue: null,
      required: false,
      validation: null,
      adminOnly: false,
      protected: false,
    });
  }
  await repository.setSetting("admin", "telegram.enabled", true);
  await repository.setSetting("admin", "telegram.bot_token", "123:fixture-token");
  await repository.setSetting("admin", "telegram.chat_id", "admin-chat");
  communication = new UserCommunicationService([new TelegramCommunicationAdapter()]);
  accepted = [];
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("https://api.telegram.org/bot123:fixture-token/sendMessage");
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    accepted.push(payload);
    return Response.json({
      ok: true,
      result: { message_id: accepted.length, date: 1, chat: { id: 7, type: "private" } },
    });
  });
  dependencies = {
    getEnabled: () => settings.getValue<boolean>(REGISTRATION_NOTIFICATION_SETTING),
    getRecipients: () => recipients.getAdminNotificationRecipients(),
    createRepository: () => repository,
    communication,
    getBaseUrl: () => "https://moira.example.test",
    getAppPrefix: () => "/app",
    logger: { info: jest.fn(), warn: jest.fn() },
  };
});

afterEach(() => {
  sqlite.close();
  jest.restoreAllMocks();
  jest.useRealTimers();
  resetClientFactory();
  if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
  else process.env.DEPLOYMENT_MODE = originalMode;
  resetFeatureResolver();
});

test("a confirmed registration reaches the real Telegram transport as plain text, without extension fan-out", async () => {
  const extension = {
    id: "fixture.notifications",
    provider: "fixture",
    capabilities: { text: true, image: false, document: false, trusted: false },
    metadata: { title: "Other", origin: "extension" as const, settingKeys: [] },
    isConfigured: jest.fn(async () => true),
    deliver: jest.fn(async () => {}),
  };
  dependencies.communication = new UserCommunicationService([
    new TelegramCommunicationAdapter(),
    extension,
  ]);
  await notifyAdminsOfRegistration(event, dependencies);
  expect(accepted).toEqual([
    {
      chat_id: "admin-chat",
      text: "New account registered\nName: Alex *<name>*\nEmail: alex@example.test\nRegistered: 1970-01-01T00:00:00.000Z\nAccount: https://moira.example.test/app/admin/users/new%20user%2Fidentity",
      link_preview_options: { is_disabled: true },
    },
  ]);
  expect(extension.isConfigured).not.toHaveBeenCalled();
  expect(extension.deliver).not.toHaveBeenCalled();
  expect(dependencies.logger.info).toHaveBeenCalledWith(
    "Registration notification completed",
    expect.objectContaining({ status: "delivered", deliveredChannels: 1 }),
  );
});

test.each(["false", null])("a persisted global preference %s prevents delivery", async (value) => {
  await settings.setValue(REGISTRATION_NOTIFICATION_SETTING, value, "admin");
  await notifyAdminsOfRegistration(event, dependencies);
  expect(accepted).toEqual([]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("a missing event preference prevents delivery instead of treating absence as enabled", async () => {
  sqlite.prepare("DELETE FROM globalSetting WHERE key = ?").run(REGISTRATION_NOTIFICATION_SETTING);
  await notifyAdminsOfRegistration(event, dependencies);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test.each(["disabled", "unconfigured"] as const)(
  "a %s Telegram channel sends nothing",
  async (state) => {
    if (state === "disabled") await repository.setSetting("admin", "telegram.enabled", false);
    else await repository.deleteUserSettingValue("admin", "telegram.chat_id");
    await notifyAdminsOfRegistration(event, dependencies);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(dependencies.logger.info).toHaveBeenCalledWith(
      "Registration notification completed",
      expect.objectContaining({ status: "no_configured_channels", deliveredChannels: 0 }),
    );
  },
);

test.each(["blocked", "pending", "not-admin"] as const)(
  "persisted %s recipient authority prevents delivery",
  async (state) => {
    if (state === "blocked") sqlite.prepare("UPDATE user SET blocked=1 WHERE id='admin'").run();
    else if (state === "pending")
      sqlite.prepare("UPDATE user SET approvedAt=NULL WHERE id='admin'").run();
    else sqlite.prepare("UPDATE user SET isAdmin=0 WHERE id='admin'").run();
    await notifyAdminsOfRegistration(event, dependencies);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  },
);

test.each(["self-host", "saas"] as const)(
  "unverified administrator follows %s admission policy",
  async (mode) => {
    process.env.DEPLOYMENT_MODE = mode;
    resetFeatureResolver();
    sqlite.prepare("UPDATE user SET emailVerified=0 WHERE id='admin'").run();
    await notifyAdminsOfRegistration(event, dependencies);
    expect(accepted).toHaveLength(mode === "self-host" ? 1 : 0);
  },
);

test("one provider refusal does not stop another administrator and is not logged as delivered", async () => {
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,handle,isAdmin,blocked,emailVerified,approvedAt,createdAt,updatedAt) VALUES ('other','Other','other@example.test','other',1,0,1,'2026-01-01','2026-01-01','2026-01-01')",
    )
    .run();
  await repository.setSetting("other", "telegram.bot_token", "123:fixture-token");
  await repository.setSetting("other", "telegram.chat_id", "other-chat");
  jest.mocked(globalThis.fetch).mockImplementation(async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (payload.chat_id === "admin-chat")
      return Response.json({ ok: false, description: "Refused" }, { status: 500 });
    accepted.push(payload);
    return Response.json({
      ok: true,
      result: { message_id: 1, date: 1, chat: { id: 8, type: "private" } },
    });
  });
  await expect(notifyAdminsOfRegistration(event, dependencies)).resolves.toBeUndefined();
  expect(accepted.map((value) => value.chat_id)).toEqual(["other-chat"]);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect(dependencies.logger.info).toHaveBeenCalledWith(
    "Registration notification completed",
    expect.objectContaining({ recipientId: "admin", status: "all_failed", deliveredChannels: 0 }),
  );
});

test("an ambiguous provider outcome times out without declaring delivery or retrying", async () => {
  jest.useFakeTimers();
  dependencies.communication = new UserCommunicationService([new TelegramCommunicationAdapter()], {
    deadlineMs: 10,
  });
  let release!: (value: Response) => void;
  jest.mocked(globalThis.fetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = notifyAdminsOfRegistration(event, dependencies);
  await jest.advanceTimersByTimeAsync(10);
  await pending;
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(dependencies.logger.info).toHaveBeenCalledWith(
    "Registration notification completed",
    expect.objectContaining({ status: "all_failed", deliveredChannels: 0 }),
  );
  release(
    Response.json({
      ok: true,
      result: { message_id: 1, date: 1, chat: { id: 7, type: "private" } },
    }),
  );
  await jest.advanceTimersByTimeAsync(5000);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(dependencies.logger.info).not.toHaveBeenCalledWith(
    "Registration notification completed",
    expect.objectContaining({ status: "delivered" }),
  );
});

test("selected-channel delivery and channel testing share provider admission limits", async () => {
  const service = new UserCommunicationService([new TelegramCommunicationAdapter()], {
    maxRequestsPerWindow: 1,
  });
  expect(
    await service.deliverChannel(
      "telegram",
      { userId: "admin", text: "Actual event", format: "plain" },
      repository,
    ),
  ).toMatchObject({ status: "delivered", deliveredChannels: 1 });
  expect(await service.testChannel("telegram", "admin", repository)).toMatchObject({
    status: "all_failed",
    channels: [{ channelId: "telegram", status: "rate_limited" }],
  });
  expect(accepted.map((value) => value.text)).toEqual(["Actual event"]);
});

test("migration seeds a global true boolean and preserves the operator's disabled value on replay", async () => {
  expect(await settings.get(REGISTRATION_NOTIFICATION_SETTING)).toMatchObject({
    type: "boolean",
    category: "system",
    value: "true",
  });
  await settings.setValue(REGISTRATION_NOTIFICATION_SETTING, "false", "admin");
  sqlite.exec(
    fs.readFileSync(
      path.join(process.cwd(), "packages/web-backend/drizzle/0052_registration_notifications.sql"),
      "utf8",
    ),
  );
  expect(await settings.getValue<boolean>(REGISTRATION_NOTIFICATION_SETTING)).toBe(false);
  expect(
    sqlite
      .prepare("SELECT count(*) AS count FROM settingDefinition WHERE key = ?")
      .get(REGISTRATION_NOTIFICATION_SETTING),
  ).toEqual({ count: 0 });
});
