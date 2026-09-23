import { describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  CodespaceConnectionError,
  type CodespaceConnectionService,
  type CodespaceConnectionView,
} from "@mcp-moira/shared";
import { createCodespaceConnectionRoutes } from "../../../packages/web-backend/src/routes/codespace-connections.js";
import { setupErrorMiddleware } from "../../../packages/web-backend/src/middleware/error-middleware.js";

const baseStatus: CodespaceConnectionView = {
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

function appWith(service: CodespaceConnectionService) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      userId: "user-a",
      session: { token: "web-session-secret" },
    });
    next();
  });
  app.use("/api/integrations", createCodespaceConnectionRoutes(service));
  app.use(setupErrorMiddleware());
  return app;
}

describe("GitHub codespace connection web routes", () => {
  test("starts authorization only as a browser redirect with no cache or referrer", async () => {
    const service = {
      getStatus: () => baseStatus,
      beginAuthorization: jest
        .fn<CodespaceConnectionService["beginAuthorization"]>()
        .mockResolvedValue("https://github.com/login/oauth/authorize?state=secret"),
    } as unknown as CodespaceConnectionService;

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
        .fn<CodespaceConnectionService["completeAuthorization"]>()
        .mockRejectedValue(new Error("provider included ghu_secret")),
    } as unknown as CodespaceConnectionService;

    const response = await request(appWith(service)).get(
      "/api/integrations/github/callback?code=code-secret&state=state-secret",
    );

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(
      "https://moira.example.com/app/settings?github=authorization_failed#integrations-github",
    );
    expect(response.text).not.toMatch(/code-secret|state-secret|ghu_secret/);
  });

  test.each([
    ["connected", "connected"],
    ["installation_required", "installation_required"],
  ] as const)(
    "an App installation return with a stored credential refreshes the grants and lands on Settings as %s",
    async (result, outcome) => {
      const completeAuthorization = jest.fn<CodespaceConnectionService["completeAuthorization"]>();
      const completeInstallationReturn = jest
        .fn<CodespaceConnectionService["completeInstallationReturn"]>()
        .mockResolvedValue(result);
      const service = {
        getStatus: () => baseStatus,
        completeAuthorization,
        completeInstallationReturn,
      } as unknown as CodespaceConnectionService;

      const response = await request(appWith(service)).get(
        "/api/integrations/github/callback?code=install-code&installation_id=4242&setup_action=install",
      );

      expect(response.status).toBe(303);
      expect(response.headers.location).toBe(
        `https://moira.example.com/app/settings?github=${outcome}#integrations-github`,
      );
      expect(completeInstallationReturn).toHaveBeenCalledWith("user-a");
      // The install return's own code is never exchanged: the stored credential suffices.
      expect(completeAuthorization).not.toHaveBeenCalled();
      expect(response.text).not.toMatch(/install-code|4242/);
    },
  );

  test("an App installation return without a usable credential starts authorization on this site", async () => {
    const service = {
      getStatus: () => baseStatus,
      completeInstallationReturn: jest
        .fn<CodespaceConnectionService["completeInstallationReturn"]>()
        .mockResolvedValue("authorization_required"),
    } as unknown as CodespaceConnectionService;

    const response = await request(appWith(service)).get(
      "/api/integrations/github/callback?installation_id=4242&setup_action=install",
    );

    expect(response.status).toBe(303);
    // Absolute and on the configured site, like the Settings URL; the API is served at the site root.
    expect(response.headers.location).toBe(
      "https://moira.example.com/api/integrations/github/start",
    );
  });

  test("an authorization that finds no installation goes straight to the GitHub App install page", async () => {
    const service = {
      getStatus: () => baseStatus,
      completeAuthorization: jest
        .fn<CodespaceConnectionService["completeAuthorization"]>()
        .mockResolvedValue({
          ...baseStatus,
          state: "installation_required",
          installationUrl: "https://github.com/apps/moira-codespaces/installations/new",
        }),
    } as unknown as CodespaceConnectionService;

    const response = await request(appWith(service)).get(
      "/api/integrations/github/callback?code=code-abcdef&state=state-abcdefghijklmnopqrstuvwxyz",
    );

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(
      "https://github.com/apps/moira-codespaces/installations/new",
    );
  });

  test.each([
    [
      "an account that is already connected",
      { ...baseStatus, state: "connected" as const },
      new CodespaceConnectionError("AUTHORIZATION_FAILED", "Disconnect GitHub first"),
      "already_connected",
    ],
    [
      "an unconfigured instance",
      baseStatus,
      new CodespaceConnectionError("CODESPACE_NOT_CONFIGURED", "not configured"),
      "not_configured",
    ],
    [
      "previous access that could not be revoked",
      baseStatus,
      new CodespaceConnectionError("AUTH_REFRESH_FAILED", "Pending GitHub access must be revoked"),
      "previous_access_not_revoked",
    ],
  ])(
    "a start refused for %s returns the browser to Settings with an outcome instead of JSON",
    async (_name, status, error, outcome) => {
      const service = {
        getStatus: () => status,
        beginAuthorization: jest
          .fn<CodespaceConnectionService["beginAuthorization"]>()
          .mockRejectedValue(error),
      } as unknown as CodespaceConnectionService;

      const response = await request(appWith(service)).get("/api/integrations/github/start");

      expect(response.status).toBe(303);
      expect(response.headers.location).toBe(
        `https://moira.example.com/app/settings?github=${outcome}#integrations-github`,
      );
    },
  );

  test.each([
    ["the site root", undefined, "/settings?github=authorization_failed#integrations-github"],
    ["an app prefix", "/app/", "/app/settings?github=authorization_failed#integrations-github"],
  ])(
    "when the connection status cannot be read, the callback still lands the browser on Settings under %s, never on JSON",
    async (_label, appBasePath, location) => {
      const previous = process.env.APP_BASE_PATH;
      if (appBasePath === undefined) delete process.env.APP_BASE_PATH;
      else process.env.APP_BASE_PATH = appBasePath;
      try {
        const service = {
          getStatus: () => {
            throw new Error("codespace status unavailable");
          },
        } as unknown as CodespaceConnectionService;

        const response = await request(appWith(service)).get(
          "/api/integrations/github/callback?code=pre-try-code-secret&state=pre-try-state-secret",
        );

        expect(response.status).toBe(303);
        expect(response.headers.location).toBe(location);
        expect(response.headers["content-type"] ?? "").not.toMatch(/json/);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["referrer-policy"]).toBe("no-referrer");
        expect(response.text).not.toMatch(/pre-try-code-secret|pre-try-state-secret/);
      } finally {
        if (previous === undefined) delete process.env.APP_BASE_PATH;
        else process.env.APP_BASE_PATH = previous;
      }
    },
  );

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
        .fn<CodespaceConnectionService["completeAuthorization"]>()
        .mockResolvedValue({ ...baseStatus, state: "connected" }),
    } as unknown as CodespaceConnectionService;

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
    const refreshGrants = jest
      .fn<CodespaceConnectionService["refreshGrants"]>()
      .mockResolvedValue({ refreshed: false, stale: false });
    const service = {
      getStatus: () => baseStatus,
      refreshGrants,
    } as unknown as CodespaceConnectionService;
    const response = await request(appWith(service)).get("/api/integrations/github");
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ ...baseStatus, repositoriesStale: false });
    expect(refreshGrants).toHaveBeenCalledWith("user-a");
    expect(JSON.stringify(response.body)).not.toMatch(/token|connectionId|clientSecret/i);
  });

  test("forces a grant refresh and reports a retained stale snapshot", async () => {
    const refreshGrants = jest
      .fn<CodespaceConnectionService["refreshGrants"]>()
      .mockResolvedValue({ refreshed: false, stale: true });
    const service = {
      getStatus: () => baseStatus,
      refreshGrants,
    } as unknown as CodespaceConnectionService;

    const response = await request(appWith(service)).post("/api/integrations/github/refresh");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ ...baseStatus, repositoriesStale: true });
    expect(refreshGrants).toHaveBeenCalledWith("user-a", { force: true });
  });

  test("requires explicit website confirmation before forgetting an externally revoked credential", async () => {
    const recovered = { ...baseStatus, state: "disconnected" as const, canConnect: true };
    const service = {
      getStatus: () => baseStatus,
      confirmExternalRevocation: jest
        .fn<CodespaceConnectionService["confirmExternalRevocation"]>()
        .mockResolvedValue(recovered),
    } as unknown as CodespaceConnectionService;

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
        .fn<CodespaceConnectionService["confirmExternalRevocation"]>()
        .mockRejectedValue(
          new CodespaceConnectionError(
            "AUTHORIZATION_FAILED",
            "The GitHub connection does not require external revocation recovery",
          ),
        ),
    } as unknown as CodespaceConnectionService;

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
