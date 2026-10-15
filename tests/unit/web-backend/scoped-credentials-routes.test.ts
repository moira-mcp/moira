import { describe, expect, jest, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { ScopedCredentialError } from "@mcp-moira/shared";
import { createScopedCredentialRouter } from "../../../packages/web-backend/src/routes/scoped-credentials.js";
const bearer = "a".repeat(43);
const input = {
  resourceId: randomUUID(),
  resourceGeneration: 1,
  action: "fetch",
  requestId: "ws1-" + randomUUID(),
};
describe("private scoped credential routes", () => {
  test("retained disposal uncertainty is truthful in the private HTTP reply and does not reach global logging", async () => {
    const global = jest.fn((_error: unknown, _req: Request, res: Response, _next: NextFunction) =>
      res.sendStatus(500),
    );
    const app = express();
    app.use(
      "/credentials",
      createScopedCredentialRouter({
        collect: async () => ({ state: "absent" }),
        acquire: async () => {
          throw new ScopedCredentialError("SCOPED_CREDENTIAL_DISPOSAL_PENDING", 503);
        },
        release: async () => {},
      }),
    );
    app.use(global);
    const response = await request(app)
      .post("/credentials/acquire")
      .set("Authorization", "Bearer " + bearer)
      .send(input);
    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({
      code: "SCOPED_CREDENTIAL_DISPOSAL_PENDING",
      message: expect.stringContaining("unconfirmed"),
    });
    expect(response.text).not.toContain("refused");
    expect(global).not.toHaveBeenCalled();
  });
  test("collect uses only the existing-operation handler and rejects a changed path identity", async () => {
    const collect = jest.fn(async () => ({ state: "absent" as const }));
    const acquire = jest.fn(async () => {
      throw new Error("unexpected mint");
    });
    const app = express();
    app.use(
      "/credentials",
      createScopedCredentialRouter({ collect, acquire, release: async () => {} }),
    );
    const response = await request(app)
      .post("/credentials/requests/" + input.requestId)
      .set("Authorization", "Bearer " + bearer)
      .send(input);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: "absent" });
    expect(acquire).not.toHaveBeenCalled();
    const changed = await request(app)
      .post("/credentials/requests/ws1-" + randomUUID())
      .set("Authorization", "Bearer " + bearer)
      .send(input);
    expect(changed.status).toBe(409);
    expect(collect).toHaveBeenCalledTimes(1);
  });
  test("raw provider failures and parser bodies never reach global logging or public replies", async () => {
    const global = jest.fn((_error: unknown, _req: Request, res: Response, _next: NextFunction) =>
      res.sendStatus(500),
    );
    const app = express();
    app.use(
      "/credentials",
      createScopedCredentialRouter({
        collect: async () => ({ state: "absent" }),
        acquire: async () => {
          throw Object.assign(new Error("SYNTHETIC_CHILD_SECRET"), {
            body: { token: "SYNTHETIC_CHILD_SECRET" },
          });
        },
        release: async () => {},
      }),
    );
    app.use(global);
    const uncertain = await request(app)
      .post("/credentials/acquire")
      .set("Authorization", "Bearer " + bearer)
      .send(input);
    expect(uncertain.status).toBe(503);
    expect(uncertain.body.error.code).toBe("SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED");
    expect(uncertain.text).not.toContain("SYNTHETIC_CHILD_SECRET");
    const malformed = await request(app)
      .post("/credentials/acquire")
      .set("Content-Type", "application/json")
      .send('{"token":"SYNTHETIC_CHILD_SECRET');
    expect(malformed.status).toBe(400);
    expect(malformed.text).not.toContain("SYNTHETIC_CHILD_SECRET");
    expect(global).not.toHaveBeenCalled();
  });
  test.each([401, 403])(
    "declared pre-admission authority refusal preserves HTTP %s",
    async (status) => {
      const app = express();
      app.use(
        "/credentials",
        createScopedCredentialRouter({
          collect: async () => ({ state: "absent" }),
          acquire: async () => {
            throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", status);
          },
          release: async () => {},
        }),
      );
      const response = await request(app)
        .post("/credentials/acquire")
        .set("Authorization", "Bearer " + bearer)
        .send(input);
      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe("SCOPED_CREDENTIAL_AUTHORITY_REFUSED");
      expect(response.body.error.message).toContain("refused");
    },
  );
});
