import { expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { AuditAction, getDatabase } from "@mcp-moira/shared";
import { auth } from "../../packages/web-backend/src/auth.js";
import { getAuthUrl } from "../../packages/shared/src/config/urls.js";
import * as schema from "../../packages/shared/src/database/schema.js";

const db = getDatabase();
const users: string[] = [];
async function call(path: string, cookie?: string, body?: unknown) {
  const url = getAuthUrl();
  return auth.handler(
    new Request(`${url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: new URL(url).origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
async function register() {
  const response = await call("/sign-up/email", undefined, {
    email: `cleanup-${randomUUID()}@example.test`,
    name: "Cleanup reader",
    password: "CleanupPassword123!",
    acceptedTermsAt: new Date().toISOString(),
    acceptedNotRussianResidentAt: new Date().toISOString(),
  });
  expect(response.status).toBe(200);
  const created = (await response.json()) as { user: { id: string; email: string } };
  users.push(created.user.id);
  await db
    .update(schema.user)
    .set({ approvedAt: new Date().toISOString(), emailVerified: true })
    .where(eq(schema.user.id, created.user.id));
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const observed = await (await call("/get-session", cookie)).json();
  return { cookie, user: created.user, session: observed.session as { id: string; token: string } };
}
async function clean() {
  if (!users.length) return;
  await db.delete(schema.auditLog).where(inArray(schema.auditLog.userId, users));
  await db.delete(schema.user).where(inArray(schema.user.id, users));
  users.length = 0;
}
const logoutAudit = (id: string) =>
  db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.action, AuditAction.AUTH_SIGN_OUT),
        eq(schema.auditLog.resourceId, id),
      ),
    );

test("a blocked owner can revoke its exact current session while other authenticated operations remain denied", async () => {
  try {
    const a = await register();
    await db.update(schema.user).set({ blocked: true }).where(eq(schema.user.id, a.user.id));
    expect((await call("/list-accounts", a.cookie)).status).toBe(403);
    const response = await call("/revoke-session", a.cookie, { token: a.session.token });
    expect(response.status).toBe(200);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await (await call("/get-session", a.cookie)).json()).toBeNull();
    expect(
      await db.select().from(schema.session).where(eq(schema.session.id, a.session.id)),
    ).toHaveLength(0);
    expect(await logoutAudit(a.session.id)).toHaveLength(1);
  } finally {
    await clean();
  }
});

test("targeted cleanup preserves a foreign current session and a newer same-user session", async () => {
  try {
    const a = await register();
    const b = await register();
    const foreign = await call("/revoke-session", b.cookie, { token: a.session.token });
    expect(foreign.status).toBe(200);
    expect(await logoutAudit(b.session.id)).toHaveLength(0);
    expect((await (await call("/get-session", b.cookie)).json()).session.id).toBe(b.session.id);
    expect(
      await db.select().from(schema.session).where(eq(schema.session.id, a.session.id)),
    ).toHaveLength(1);
    const signedIn = await call("/sign-in/email", undefined, {
      email: a.user.email,
      password: "CleanupPassword123!",
    });
    expect(signedIn.status).toBe(200);
    const newerCookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    const newer = await (await call("/get-session", newerCookie)).json();
    expect(newer.session.id).not.toBe(a.session.id);
    const own = await call("/revoke-session", newerCookie, { token: a.session.token });
    expect(own.status).toBe(200);
    expect(own.headers.has("set-cookie")).toBe(false);
    expect((await (await call("/get-session", newerCookie)).json()).session.id).toBe(
      newer.session.id,
    );
    expect(await logoutAudit(newer.session.id)).toHaveLength(0);
    expect(await logoutAudit(a.session.id)).toHaveLength(0);
    expect(
      await db.select().from(schema.session).where(eq(schema.session.id, a.session.id)),
    ).toHaveLength(0);
  } finally {
    await clean();
  }
});

test("invalid-session APIError middleware cleanup does not return cookie expiry", async () => {
  try {
    const a = await register();
    await db.delete(schema.session).where(eq(schema.session.id, a.session.id));
    const response = await call("/revoke-session", a.cookie, { token: a.session.token });
    expect(response.status).toBe(401);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await logoutAudit(a.session.id)).toHaveLength(0);
  } finally {
    await clean();
  }
});

test("a real middleware renewal during foreign-target cleanup remains cookie-neutral", async () => {
  try {
    const a = await register();
    const b = await register();
    await db
      .update(schema.session)
      .set({
        expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString(),
        updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(),
      })
      .where(eq(schema.session.id, b.session.id));
    const response = await call("/revoke-session", b.cookie, { token: a.session.token });
    expect(response.status).toBe(200);
    expect(response.headers.has("set-cookie")).toBe(false);
    const [renewed] = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.id, b.session.id));
    expect(renewed.refreshedAt).not.toBeNull();
    expect((await (await call("/get-session", b.cookie)).json()).session.id).toBe(b.session.id);
    expect(
      await db.select().from(schema.session).where(eq(schema.session.id, a.session.id)),
    ).toHaveLength(1);
  } finally {
    await clean();
  }
});
