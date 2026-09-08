import { describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  WorkspaceConnectionError,
  type WorkspaceConnectionService,
  type WorkspaceConnectionView,
} from "@mcp-moira/shared";
import { createWorkspaceConnectionRoutes } from "../../../packages/web-backend/src/routes/workspace-connections.js";
import { setupErrorMiddleware } from "../../../packages/web-backend/src/middleware/error-middleware.js";

const baseStatus: WorkspaceConnectionView = {
  state: "connection_required",
  reason: "CONNECTION_REQUIRED",
  settingsUrl: "https://moira.example.com/app/settings#integrations-github",
  installationUrl: null,
  account: null,
  installations: [],
  repositories: [],
  canConnect: true,
  canDisconnect: false,
};

function appWith(service: WorkspaceConnectionService) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      userId: "user-a",
      session: { token: "web-session-secret" },
    });
    next();
  });
  app.use("/api/integrations", createWorkspaceConnectionRoutes(service));
  app.use(setupErrorMiddleware());
  return app;
}

describe("GitHub workspace connection web routes", () => {
  test("starts authorization only as a browser redirect with no cache or referrer", async () => {
    const service = {
      getStatus: () => baseStatus,
      beginAuthorization: jest
        .fn<WorkspaceConnectionService["beginAuthorization"]>()
        .mockResolvedValue("https://github.com/login/oauth/authorize?state=secret"),
    } as unknown as WorkspaceConnectionService;

    const response = await request(appWith(service)).get("/api/integrations/github/start");

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("https://github.com/login/oauth/authorize?state=secret");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  test("turns callback failure into a safe same-origin Settings result without reflecting secrets", async () => {
    const service = {
      getStatus: () => baseStatus,
      completeAuthorization: jest
        .fn<WorkspaceConnectionService["completeAuthorization"]>()
        .mockRejectedValue(new Error("provider included ghu_secret")),
    } as unknown as WorkspaceConnectionService;

    const response = await request(appWith(service)).get(
      "/api/integrations/github/callback?code=code-secret&state=state-secret",
    );

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(
      "https://moira.example.com/app/settings?github=authorization_failed#integrations-github",
    );
    expect(response.text).not.toMatch(/code-secret|state-secret|ghu_secret/);
  });

  test("keeps callback inputs secret when status resolution fails before authorization", async () => {
    const service = {
      getStatus: () => {
        throw new Error("workspace status unavailable");
      },
    } as unknown as WorkspaceConnectionService;

    const response = await request(appWith(service)).get(
      "/api/integrations/github/callback?code=pre-try-code-secret&state=pre-try-state-secret",
    );

    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(JSON.stringify(response.body)).not.toMatch(/pre-try-code-secret|pre-try-state-secret/);
    expect(response.body).toEqual({
      success: false,
      error: { code: "AUTHORIZATION_FAILED", message: "GitHub authorization failed" },
    });
  });

  test("generic callback errors omit sensitive query context", async () => {
    const app = express();
    app.get("/api/integrations/github/callback", (_req, _res, next) => {
      next(new Error("unexpected callback failure"));
    });
    app.use(setupErrorMiddleware());

    const response = await request(app).get(
      "/api/integrations/github/callback?code=generic-code-secret&state=generic-state-secret",
    );

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/generic-code-secret|generic-state-secret/);
    expect(response.body.error.details.requestContext.query).toEqual({});
  });

  test("turns callback success into a bounded Settings result without reflecting inputs", async () => {
    const service = {
      getStatus: () => baseStatus,
      completeAuthorization: jest
        .fn<WorkspaceConnectionService["completeAuthorization"]>()
        .mockResolvedValue({ ...baseStatus, state: "connected" }),
    } as unknown as WorkspaceConnectionService;

    const response = await request(appWith(service)).get(
      "/api/integrations/github/callback?code=successful-code-secret&state=successful-state-secret",
    );

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(
      "https://moira.example.com/app/settings?github=connected#integrations-github",
    );
    expect(`${response.headers.location}\n${response.text}`).not.toMatch(
      /successful-code-secret|successful-state-secret/,
    );
  });

  test("returns only the sanitized tenant connection view", async () => {
    const service = { getStatus: () => baseStatus } as unknown as WorkspaceConnectionService;
    const response = await request(appWith(service)).get("/api/integrations/github");
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(baseStatus);
    expect(JSON.stringify(response.body)).not.toMatch(/token|connectionId|clientSecret/i);
  });

  test("requires explicit website confirmation before forgetting an externally revoked credential", async () => {
    const recovered = { ...baseStatus, state: "disconnected" as const, canConnect: true };
    const service = {
      getStatus: () => baseStatus,
      confirmExternalRevocation: jest
        .fn<WorkspaceConnectionService["confirmExternalRevocation"]>()
        .mockResolvedValue(recovered),
    } as unknown as WorkspaceConnectionService;

    const response = await request(appWith(service))
      .delete("/api/integrations/github/external-revocation")
      .send({ confirmed: true });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(recovered);
    expect(service.confirmExternalRevocation).toHaveBeenCalledWith("user-a", true);
  });

  test("rejects external abandon when the current credential is readable", async () => {
    const service = {
      getStatus: () => ({ ...baseStatus, state: "refresh_failed" as const }),
      confirmExternalRevocation: jest
        .fn<WorkspaceConnectionService["confirmExternalRevocation"]>()
        .mockRejectedValue(
          new WorkspaceConnectionError(
            "AUTHORIZATION_FAILED",
            "The GitHub connection does not require external revocation recovery",
          ),
        ),
    } as unknown as WorkspaceConnectionService;

    const response = await request(appWith(service))
      .delete("/api/integrations/github/external-revocation")
      .send({ confirmed: true });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: "AUTHORIZATION_FAILED" },
    });
  });
});
