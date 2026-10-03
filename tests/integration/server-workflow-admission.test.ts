import { expect, jest, test } from "@jest/globals";
import express, { type Application } from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDatabase, resetFeatureResolver, WorkflowRepository } from "@mcp-moira/shared";
import * as schema from "../../packages/shared/src/database/schema.js";
import { auth } from "../../packages/web-backend/src/auth.js";
import * as rateLimits from "../../packages/web-backend/src/middleware/rate-limit-middleware.js";

// Use the production limiter with its usual test bypass explicitly disabled.
const limiters = rateLimits.createRateLimiters({ skipLimits: false, whitelist: [] });
jest.unstable_mockModule(
  "../../packages/web-backend/src/middleware/rate-limit-middleware.js",
  () => ({ ...rateLimits, ...limiters }),
);
const { MoiraApiServer } = await import("../../packages/web-backend/src/server.js");
const { userProfileRoutes } = await import("../../packages/web-backend/src/routes/user-profile.js");
const { default: userOAuthSessionsRoutes } =
  await import("../../packages/web-backend/src/routes/user-oauth-sessions.js");

test("mounted workflow list and sharing aliases consume one admission and one API quota while retaining denial", async () => {
  const app = (new MoiraApiServer() as unknown as { app: Application }).app;
  const db = getDatabase();
  const ids: string[] = [];
  let workflowId: string = randomUUID();
  const getSession = jest.spyOn(auth.api, "getSession");
  try {
    const registered = await auth.handler(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `mounted-${randomUUID()}@example.test`,
          name: "Mounted Reader",
          password: "ReadProtocol123!",
          termsAccepted: true,
          nonResidentAccepted: true,
        }),
      }),
    );
    expect(registered.status).toBe(200);
    const owner = (await registered.json()) as { user: { id: string } };
    ids.push(owner.user.id);
    const cookie = registered.headers.get("set-cookie")!.split(";")[0];
    await db
      .update(schema.user)
      .set({ approvedAt: new Date().toISOString(), emailVerified: true })
      .where(eq(schema.user.id, owner.user.id));
    const [user] = await db.select().from(schema.user).where(eq(schema.user.id, owner.user.id));
    const saved = await new WorkflowRepository(db).save({
      graph: {
        id: workflowId,
        metadata: { name: "Mounted Workflow", version: "1.0.0", description: "" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      },
      userId: owner.user.id,
    });
    workflowId = saved.id;
    const [stored] = await db
      .select()
      .from(schema.workflow)
      .where(eq(schema.workflow.id, workflowId));
    const quotaProbe = await request(app).get("/api/user/me").set("Cookie", cookie);
    expect(quotaProbe.status).toBe(200);
    let remaining = Number(quotaProbe.headers["ratelimit-remaining"]);
    for (const url of [
      "/api/workflows?access=mine",
      `/api/workflows/${workflowId}/invites`,
      `/api/workflows/${user.handle}/${stored.slug}/invites`,
      `/api/workflows/${workflowId}/access`,
      `/api/workflows/${user.handle}/${stored.slug}/access`,
    ]) {
      getSession.mockClear();
      const response = await request(app).get(url).set("Cookie", cookie);
      expect(response.status).toBe(200);
      expect(getSession).toHaveBeenCalledTimes(1);
      expect(Number(response.headers["ratelimit-remaining"])).toBe(--remaining);
      expect(response.body.success).toBe(true);
      if (url.includes("access=mine"))
        expect(response.body.data.workflows.map((row: { id: string }) => row.id)).toContain(
          workflowId,
        );
      else expect(response.body.data.total).toBe(0);
    }
    getSession.mockClear();
    expect((await request(app).get("/api/workflows")).status).toBe(401);
    expect(getSession).toHaveBeenCalledTimes(1);
    await db.update(schema.user).set({ blocked: true }).where(eq(schema.user.id, owner.user.id));
    getSession.mockClear();
    const denied = await request(app)
      .get(`/api/workflows/${workflowId}/invites`)
      .set("Cookie", cookie);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("ACCOUNT_BLOCKED");
    expect(getSession).toHaveBeenCalledTimes(1);
  } finally {
    getSession.mockRestore();
    await db.delete(schema.workflow).where(eq(schema.workflow.id, workflowId));
    if (ids.length) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.userId, ids));
      await db.delete(schema.user).where(inArray(schema.user.id, ids));
    }
  }
});

test("mounted user routes consume one quota and admission, preserve standalone guards and pending account status", async () => {
  const app = (new MoiraApiServer() as unknown as { app: Application }).app;
  const db = getDatabase();
  const oldMode = process.env.DEPLOYMENT_MODE;
  let userId: string | undefined;
  const getSession = jest.spyOn(auth.api, "getSession");
  try {
    const registered = await auth.handler(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `mounted-user-${randomUUID()}@example.test`,
          name: "User Reader",
          password: "ReadProtocol123!",
          termsAccepted: true,
          nonResidentAccepted: true,
        }),
      }),
    );
    expect(registered.status).toBe(200);
    userId = ((await registered.json()) as { user: { id: string } }).user.id;
    const cookie = registered.headers.get("set-cookie")!.split(";")[0];
    await db
      .update(schema.user)
      .set({ approvedAt: new Date().toISOString(), emailVerified: true })
      .where(eq(schema.user.id, userId));
    const probe = await request(app).get("/api/user/me").set("Cookie", cookie);
    expect(probe.status).toBe(200);
    let remaining = Number(probe.headers["ratelimit-remaining"]);
    for (const url of [
      "/api/user/profile",
      "/api/user/handle",
      "/api/user/sessions",
      "/api/user/oauth-consents",
    ]) {
      getSession.mockClear();
      const response = await request(app).get(url).set("Cookie", cookie);
      expect(response.status).toBe(200);
      expect(getSession).toHaveBeenCalledTimes(1);
      expect(Number(response.headers["ratelimit-remaining"])).toBe(--remaining);
    }
    getSession.mockClear();
    const unknown = await request(app).get("/api/user/not-a-user-route").set("Cookie", cookie);
    expect(unknown.status).toBe(404);
    expect(getSession).not.toHaveBeenCalled();
    expect(unknown.headers["ratelimit-remaining"]).toBeUndefined();
    const standalone = express();
    standalone.use(express.json());
    standalone.use(userProfileRoutes, userOAuthSessionsRoutes);
    for (const [method, path] of [
      ["get", "/profile"],
      ["patch", "/profile"],
      ["post", "/change-password"],
      ["post", "/set-password"],
      ["post", "/resend-verification"],
      ["get", "/handle"],
      ["patch", "/handle"],
      ["get", "/oauth-consents"],
      ["delete", "/oauth-consents/unknown"],
      ["get", "/sessions"],
      ["delete", "/sessions/unknown"],
    ] as const) {
      getSession.mockClear();
      const response = await request(standalone)[method](path);
      expect(response.status).toBe(401);
      expect(getSession).toHaveBeenCalledTimes(1);
    }
    process.env.DEPLOYMENT_MODE = "self-host";
    resetFeatureResolver();
    await db.update(schema.user).set({ approvedAt: null }).where(eq(schema.user.id, userId));
    const pending = await request(app).get("/api/user/me").set("Cookie", cookie);
    expect(pending.status).toBe(200);
    expect(pending.body.data.accountApproved).toBe(false);
    for (const url of ["/api/user/profile", "/api/user/sessions", "/api/workflows"]) {
      getSession.mockClear();
      const denied = await request(app).get(url).set("Cookie", cookie);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("ACCOUNT_APPROVAL_REQUIRED");
      expect(getSession).toHaveBeenCalledTimes(1);
    }
  } finally {
    getSession.mockRestore();
    if (oldMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = oldMode;
    resetFeatureResolver();
    if (userId) {
      await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, userId));
      await db.delete(schema.user).where(eq(schema.user.id, userId));
    }
  }
});
