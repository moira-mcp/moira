/** @jest-environment node */

import { describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  CommunicationChannelRegistry,
  UserCommunicationService,
  type CommunicationChannelAdapter,
  type IDataRepository,
} from "@mcp-moira/workflow-engine";
import { setupErrorMiddleware } from "../../../packages/web-backend/src/middleware/error-middleware.js";
import { createNotificationsRouter } from "../../../packages/web-backend/src/routes/notifications.js";

function appFor(
  userId: string,
  settings: Map<string, unknown>,
  settingsByUser: Map<string, Map<string, unknown>> = new Map([[userId, settings]]),
) {
  const deliveries: string[] = [];
  const adapter: CommunicationChannelAdapter = {
    id: "probe.notifications",
    provider: "extension.probe",
    capabilities: { text: true, image: false, document: true, trusted: false },
    metadata: {
      title: "Probe notifications",
      description: "Distinctive extension channel",
      origin: "extension",
      extensionName: "probe",
      extensionVersion: "1.2.3",
      settingKeys: ["probe.enabled", "probe.endpoint", "probe.token"],
      enabledSetting: "probe.enabled",
      trustedDeliveryDeclared: true,
    },
    async isConfigured(configuration) {
      if ((await configuration.get("probe.token")) === "runner-stalled") {
        return new Promise<boolean>(() => {});
      }
      if ((await configuration.get("probe.token")) === "runner-down") {
        throw new Error("private runner diagnostic");
      }
      return (
        (await configuration.get("probe.enabled")) !== false &&
        Boolean(await configuration.get("probe.endpoint")) &&
        Boolean(await configuration.get("probe.token"))
      );
    },
    async deliver(message) {
      deliveries.push(message.text);
    },
  };
  const registry = new CommunicationChannelRegistry([adapter]);
  const repository = {
    getSetting: async <T>(owner: string, key: string) =>
      (settingsByUser.get(owner)?.get(key) as T) ?? null,
  } as IDataRepository;
  const communicationService = new UserCommunicationService(registry);
  const testChannel = jest.spyOn(communicationService, "testChannel");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { userId: string }).userId = userId;
    next();
  });
  app.use(
    "/api/notifications",
    createNotificationsRouter({
      registry,
      communicationService,
      createRepository: () => repository,
      isTrustedApproved: async () => true,
      configurationDeadlineMs: 20,
    }),
  );
  app.use(setupErrorMiddleware());
  return { app, deliveries, testChannel };
}

describe("communication channel settings API", () => {
  test("derives readiness independently from each authenticated user's settings", async () => {
    const settingsByUser = new Map<string, Map<string, unknown>>([
      [
        "user-a",
        new Map([
          ["probe.enabled", true],
          ["probe.endpoint", "private-a-endpoint"],
          ["probe.token", "private-a-token"],
        ]),
      ],
      ["user-b", new Map([["probe.enabled", true]])],
    ]);
    const userA = appFor("user-a", settingsByUser.get("user-a")!, settingsByUser);
    const userB = appFor("user-b", settingsByUser.get("user-b")!, settingsByUser);

    const ready = await request(userA.app).get("/api/notifications/channels");
    const incomplete = await request(userB.app).get("/api/notifications/channels");

    expect(ready.body.data[0]).toEqual(expect.objectContaining({ state: "ready" }));
    expect(incomplete.body.data[0]).toEqual(expect.objectContaining({ state: "incomplete" }));
    expect(JSON.stringify([ready.body, incomplete.body])).not.toContain("private-a-");
  });

  test("projects metadata and same-user state without settings or secret values", async () => {
    const settings = new Map<string, unknown>([
      ["probe.enabled", true],
      ["probe.endpoint", "https://private.example.invalid/hook"],
      ["probe.token", "private-token"],
    ]);
    const { app } = appFor("user-a", settings);
    const response = await request(app).get("/api/notifications/channels");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({
        id: "probe.notifications",
        title: "Probe notifications",
        origin: "extension",
        state: "ready",
        configured: true,
        settingKeys: ["probe.enabled", "probe.endpoint", "probe.token"],
        trustedDelivery: { declared: true, approved: true, eligible: true },
      }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain("private-token");
    expect(JSON.stringify(response.body)).not.toContain("private.example.invalid");

    settings.delete("probe.token");
    const incomplete = await request(app).get("/api/notifications/channels");
    expect(incomplete.body.data[0]).toEqual(
      expect.objectContaining({ state: "incomplete", configured: false }),
    );

    settings.set("probe.enabled", false);
    const disabled = await request(app).get("/api/notifications/channels");
    expect(disabled.body.data[0]).toEqual(
      expect.objectContaining({ state: "disabled", enabled: false, available: true }),
    );

    settings.set("probe.enabled", true);
    settings.set("probe.token", "runner-down");
    const unavailable = await request(app).get("/api/notifications/channels");
    expect(unavailable.body.data[0]).toEqual(
      expect.objectContaining({ state: "unavailable", configured: false, available: false }),
    );
    expect(JSON.stringify(unavailable.body)).not.toContain("private runner diagnostic");
  });

  test("tests the selected stored channel without accepting credentials or recipients", async () => {
    const settings = new Map<string, unknown>([
      ["probe.enabled", true],
      ["probe.endpoint", "configured"],
      ["probe.token", "secret"],
    ]);
    const { app, deliveries, testChannel } = appFor("user-a", settings);

    const refused = await request(app)
      .post("/api/notifications/channels/probe.notifications/test")
      .send({ recipient: "someone-else", token: "browser-secret" });
    expect(refused.status).toBe(400);
    expect(testChannel).not.toHaveBeenCalled();

    const refusedArray = await request(app)
      .post("/api/notifications/channels/probe.notifications/test")
      .send(["browser-supplied"]);
    expect(refusedArray.status).toBe(400);
    expect(testChannel).not.toHaveBeenCalled();

    const delivered = await request(app).post(
      "/api/notifications/channels/probe.notifications/test",
    );
    expect(delivered.status).toBe(200);
    expect(delivered.body.data).toEqual(
      expect.objectContaining({ status: "delivered", deliveredChannels: 1 }),
    );
    expect(testChannel).toHaveBeenCalledWith("probe.notifications", "user-a", expect.anything());
    expect(deliveries).toEqual(["Test notification from MCP Moira."]);

    const missing = await request(app).post("/api/notifications/channels/missing/test");
    expect(missing.status).toBe(404);
  });

  test("bounds a non-settling extension configuration probe", async () => {
    const settings = new Map<string, unknown>([
      ["probe.enabled", true],
      ["probe.endpoint", "configured"],
      ["probe.token", "runner-stalled"],
    ]);
    const { app } = appFor("user-a", settings);

    const response = await request(app).get("/api/notifications/channels");

    expect(response.status).toBe(200);
    expect(response.body.data[0]).toEqual(
      expect.objectContaining({ state: "unavailable", configured: false, available: false }),
    );
  });
});
