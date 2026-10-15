import { describe, expect, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { type LocalDeviceService, localControlRequestSchema } from "@mcp-moira/shared";
import { createLocalDeviceManagementRoutes } from "../../../packages/web-backend/src/routes/local-devices.js";

const origin = "https://moira.example";
const deviceId = randomUUID();
const path = `/devices/${deviceId}/settings`;
function fixture(revokeDuringBody = false) {
  const submissions: unknown[] = [];
  const escapedErrors: unknown[] = [];
  const service = {
    async requestSettings(userId: string, id: string, input: unknown) {
      submissions.push({ userId, id, input });
      return { accepted: true };
    },
  } as unknown as LocalDeviceService;
  const app = express();
  let active = true;
  app.use((req, _res, next) => {
    Object.assign(req, {
      userId: "owner",
      ...(req.get("X-Fixture-Session") === "yes" ? { session: { token: "private-session" } } : {}),
    });
    if (revokeDuringBody)
      req.once("end", () => {
        active = false;
      });
    next();
  });
  app.use(
    createLocalDeviceManagementRoutes(service, origin, (_req, res, next) => {
      if (!active) {
        res.status(401).json({ error: { code: "AUTHENTICATION_REQUIRED" } });
        return;
      }
      next();
    }),
  );
  // The ordinary web API still owns its separate bounded parser.
  app.use(express.json({ limit: "10mb" }));
  app.post("/ordinary", (_req, res) => res.json({ accepted: true }));
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      escapedErrors.push(error);
      if ((error as { type?: unknown })?.type === "entity.too.large") {
        res.status(413).json({ error: "Ordinary API body is too large" });
        return;
      }
      res.status(500).json({ error: "Unexpected global error" });
    },
  );
  return { app, submissions, escapedErrors };
}

describe("browser Local settings body admission", () => {
  test("session revocation while receiving the body prevents owner submission", async () => {
    const f = fixture(true);
    const response = await request(f.app)
      .put(path)
      .set("Origin", origin)
      .set("X-Fixture-Session", "yes")
      .send({ requestId: `ws1-${randomUUID()}` });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(f.submissions).toEqual([]);
    expect(f.escapedErrors).toEqual([]);
  });
  test("schema-valid settings larger than the ordinary API body ceiling reach the owner boundary intact", async () => {
    const f = fixture();
    const input = {
      requestId: `ws1-${randomUUID()}`,
      expectedGeneration: 1,
      expectedRevision: 0,
      settings: {
        label: "Owner policy",
        enabled: true,
        leaseUntil: Date.now() + 60_000,
        cpuCores: 1,
        memoryBytes: 1024,
        storageBytes: 2048,
        dockerBytes: 1024,
        gitAuthor: null,
        agentRepositoryManagement: null,
        repositories: Array.from({ length: 40_000 }, (_, index) => ({
          id: randomUUID(),
          fullName: `${"o".repeat(100)}/${String(index).padStart(100, "r")}`,
          private: true,
          allowPush: false,
          allowDelete: false,
        })),
      },
    };
    const body = JSON.stringify(input);
    expect(Buffer.byteLength(body)).toBeGreaterThan(10 * 1024 * 1024);
    expect(localControlRequestSchema.safeParse(input).success).toBe(true);
    const response = await request(f.app)
      .put(path)
      .set("Origin", origin)
      .set("X-Fixture-Session", "yes")
      .set("Content-Type", "application/json")
      .send(body);
    expect(response.status).toBe(200);
    expect(f.submissions).toEqual([{ userId: "owner", id: deviceId, input }]);
    expect(f.escapedErrors).toEqual([]);
    const ordinary = await request(f.app)
      .post("/ordinary")
      .set("Content-Type", "application/json")
      .send(body);
    expect(ordinary.status).toBe(413);
  });

  test.each([
    { session: false, origin, authorization: false, status: 401 },
    { session: true, origin: undefined, authorization: false, status: 401 },
    { session: true, origin, authorization: true, status: 401 },
    { session: true, origin: "https://foreign.example", authorization: false, status: 403 },
  ])("browser admission refuses malformed input before parsing: %j", async (gate) => {
    const f = fixture();
    const pending = request(f.app).put(path).set("Content-Type", "application/json");
    if (gate.session) pending.set("X-Fixture-Session", "yes");
    if (gate.origin) pending.set("Origin", gate.origin);
    if (gate.authorization) pending.set("Authorization", "Bearer forbidden");
    const response = await pending.send('{"private-policy-sentinel":');
    expect(response.status).toBe(gate.status);
    expect(response.body.error.code).toBe("LOCAL_UNAUTHORIZED");
    expect(JSON.stringify(response.body)).not.toContain("private-policy-sentinel");
    expect(f.submissions).toEqual([]);
    expect(f.escapedErrors).toEqual([]);
  });

  test("admitted malformed JSON is a controlled private refusal", async () => {
    const f = fixture();
    const response = await request(f.app)
      .put(path)
      .set("Origin", origin)
      .set("X-Fixture-Session", "yes")
      .set("Content-Type", "application/json")
      .send('{"private-policy-sentinel":');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("LOCAL_INVALID");
    expect(JSON.stringify(response.body)).not.toContain("private-policy-sentinel");
    expect(f.submissions).toEqual([]);
    expect(f.escapedErrors).toEqual([]);
  });
});
