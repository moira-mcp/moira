/**
 * Integration: the client address cannot be chosen by the client.
 *
 * Every consumer of the client address — the web-backend and MCP rate limiters, their whitelist, audit
 * records and Better Auth's session address — uses req.ip resolved through the proxies TRUST_PROXY
 * names. Requests reach the test app on a loopback socket, like the Node services behind the
 * in-container nginx, which appends the address it saw to X-Forwarded-For. Everything to the left of
 * that is whatever the client sent.
 *
 * The limiters are built with the shipped factories and the test-environment skip turned off, so their
 * real key and whitelist decisions are observed through the RateLimit-* response headers.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import { randomUUID } from "node:crypto";
import express, { type RequestHandler } from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  applyTrustProxy,
  clientIpFromHeaders,
  clientIpHeaderMiddleware,
  getAuditRequestContext,
  CLIENT_IP_HEADER,
} from "@mcp-moira/shared";
import { createRateLimiters } from "../../packages/web-backend/src/middleware/rate-limit-middleware.js";
import { createMcpLimiter } from "../../packages/mcp-server/src/middleware/rate-limit-middleware.js";

const CLIENT = "203.0.113.10";
const originalTrustProxy = process.env.TRUST_PROXY;

afterEach(() => {
  if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = originalTrustProxy;
});

function appWith(limiter: RequestHandler, trustProxy?: string) {
  if (trustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = trustProxy;
  const app = express();
  applyTrustProxy(app);
  app.use(clientIpHeaderMiddleware());
  app.use(limiter);
  app.get("/", (req, res) => {
    res.json({
      ip: req.ip,
      audit: getAuditRequestContext(req).ip,
      header: clientIpFromHeaders(new Headers(req.headers as Record<string, string>)),
    });
  });
  return app;
}

function webLimiter(whitelist: string[] = []) {
  return createRateLimiters({ skipLimits: false, whitelist }).apiLimiter;
}

describe("client address behind the default proxy trust (in-container nginx only)", () => {
  it("keys two requests with different spoofed X-Forwarded-For values as one client", async () => {
    const app = appWith(webLimiter());

    const first = await request(app).get("/").set("X-Forwarded-For", `1.1.1.1, ${CLIENT}`);
    const second = await request(app).get("/").set("X-Forwarded-For", `2.2.2.2, ${CLIENT}`);

    expect(first.body.ip).toBe(CLIENT);
    expect(second.body.ip).toBe(CLIENT);
    expect(first.headers["ratelimit-remaining"]).toBe("99");
    expect(second.headers["ratelimit-remaining"]).toBe("98");
  });

  it("does not skip the limit for a client that claims a whitelisted address", async () => {
    const app = appWith(webLimiter(["1.1.1.1"]));

    const res = await request(app).get("/").set("X-Forwarded-For", `1.1.1.1, ${CLIENT}`);

    expect(res.body.ip).toBe(CLIENT);
    expect(res.headers["ratelimit-remaining"]).toBe("99");
  });

  it("skips the limit for a client whose own address is whitelisted", async () => {
    const app = appWith(webLimiter([CLIENT]));

    const res = await request(app).get("/").set("X-Forwarded-For", CLIENT);

    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-remaining"]).toBeUndefined();
  });

  it("keys a client on a private network by its own address, not by the address it wrote", async () => {
    const app = appWith(webLimiter());

    const res = await request(app).get("/").set("X-Forwarded-For", "8.8.8.8, 10.0.0.5");

    expect(res.body.ip).toBe("10.0.0.5");
  });

  it("gives audit records and Better Auth hooks the same address as the limiter, whatever the client sends", async () => {
    const app = appWith(webLimiter());

    const res = await request(app)
      .get("/")
      .set("X-Forwarded-For", `1.1.1.1, ${CLIENT}`)
      .set(CLIENT_IP_HEADER, "9.9.9.9");

    expect(res.body).toEqual({ ip: CLIENT, audit: CLIENT, header: CLIENT });
  });
});

describe("client address behind an outer proxy (TRUST_PROXY=2: Traefik, then nginx)", () => {
  const TRAEFIK = "172.18.0.3";

  it("uses the address the outer proxy wrote and ignores entries the client added", async () => {
    const app = appWith(webLimiter(), "2");

    const plain = await request(app).get("/").set("X-Forwarded-For", `${CLIENT}, ${TRAEFIK}`);
    const spoofed = await request(app)
      .get("/")
      .set("X-Forwarded-For", `6.6.6.6, ${CLIENT}, ${TRAEFIK}`);

    expect(plain.body.ip).toBe(CLIENT);
    expect(spoofed.body.ip).toBe(CLIENT);
    expect(spoofed.headers["ratelimit-remaining"]).toBe("98");
  });
});

describe("MCP server limiter", () => {
  it("keys requests by the resolved client address, so spoofed entries share one budget", async () => {
    const app = appWith(createMcpLimiter({ skipLimits: false }));

    const first = await request(app).get("/").set("X-Forwarded-For", `1.1.1.1, ${CLIENT}`);
    const second = await request(app).get("/").set("X-Forwarded-For", `2.2.2.2, ${CLIENT}`);
    const other = await request(app).get("/").set("X-Forwarded-For", "198.51.100.99");

    expect(first.headers["ratelimit-remaining"]).toBe("999");
    expect(second.headers["ratelimit-remaining"]).toBe("998");
    expect(other.headers["ratelimit-remaining"]).toBe("999");
  });
});

describe("Better Auth session and audit address", () => {
  it("records the server-written client address, not a forged X-Forwarded-For", async () => {
    const { getDatabase, user, session, auditLog, AuditAction } = await import("@mcp-moira/shared");
    const { auth } = await import("../../packages/web-backend/src/auth.js");
    const email = `client-ip-${randomUUID()}@example.com`;
    const db = getDatabase();

    try {
      const res = await auth.handler(
        new Request("http://localhost/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "6.6.6.6",
            [CLIENT_IP_HEADER]: CLIENT,
          },
          body: JSON.stringify({ email, password: "ClientIp123!", name: "Client IP" }),
        }),
      );
      expect(res.status).toBe(200);

      const [created] = await db.select().from(user).where(eq(user.email, email));
      const sessions = await db.select().from(session).where(eq(session.userId, created.id));
      const audits = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, created.id), eq(auditLog.action, AuditAction.AUTH_SIGN_UP)));

      expect(sessions.map((entry) => entry.ipAddress)).toEqual([CLIENT]);
      expect(audits.map((entry) => entry.ip)).toEqual([CLIENT]);
    } finally {
      const [created] = await db.select().from(user).where(eq(user.email, email));
      if (created) {
        await db.delete(auditLog).where(eq(auditLog.userId, created.id));
        await db.delete(session).where(eq(session.userId, created.id));
        await db.delete(user).where(eq(user.id, created.id));
      }
    }
  });
});
