import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import express from "express";
import * as path from "node:path";
import request from "supertest";
import {
  WorkspaceConnectionRepository,
  WorkspaceConnectionService,
  type GitHubWorkspaceClient,
  type WorkspaceGitHubConfigStatus,
} from "@mcp-moira/shared";
import { createWorkspaceConnectionRoutes } from "../../packages/web-backend/src/routes/workspace-connections.js";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const config: Extract<WorkspaceGitHubConfigStatus, { state: "available" }> = {
  state: "available",
  clientId: "Iv23abcdefgh1234",
  clientSecret: "github-app-client-secret-value-1234567890",
  callbackUrl: "https://moira.example.com/api/integrations/github/callback",
  installationUrl: "https://github.com/apps/moira-workspaces/installations/new",
  vaultKeyHex: "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805",
  vaultKeyVersion: "v1",
  settingsUrl: "https://moira.example.com/app/settings#integrations-github",
};

class VerticalGitHubClient implements GitHubWorkspaceClient {
  exchangedCode: string | null = null;
  revokedGrantToken: string | null = null;

  async exchangeCode(code: string) {
    this.exchangedCode = code;
    return {
      accessToken: "ghu_vertical-access-secret",
      refreshToken: "ghr_vertical-refresh-secret",
      accessTokenExpiresAt: 2_000_000,
      refreshTokenExpiresAt: 9_000_000,
    };
  }

  async refreshToken() {
    throw new Error("not used");
  }

  async getUser() {
    return { id: "25282049", login: "witqq" };
  }

  async listInstallations() {
    return [
      {
        id: "9001",
        accountId: "25282049",
        accountLogin: "witqq",
        targetType: "User",
        repositorySelection: "selected" as const,
      },
    ];
  }

  async listInstallationRepositories() {
    return [{ id: "101", fullName: "witqq/private-project", private: true }];
  }

  async revokeToken() {}

  async revokeGrant(accessToken: string) {
    this.revokedGrantToken = accessToken;
  }
}

describe("GitHub workspace authenticated HTTP lifecycle", () => {
  let sqlite: Database.Database;
  let github: VerticalGitHubClient;
  let app: express.Express;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    migrate(drizzle(sqlite), { migrationsFolder: migrations });
    sqlite
      .prepare(
        `INSERT INTO user (id, email, name, handle, createdAt, updatedAt)
         VALUES ('user-a', 'a@example.test', 'User A', 'user-a', 'now', 'now')`,
      )
      .run();
    github = new VerticalGitHubClient();
    const service = new WorkspaceConnectionService({
      repository: new WorkspaceConnectionRepository(sqlite),
      config: () => config,
      client: () => github,
      now: () => 1_000_000,
      randomState: () => "vertical_state_abcdefghijklmnopqrstuvwxyz0123456789",
      randomId: () => "vertical-revocation-id",
    });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { userId: "user-a", session: { token: "vertical-web-session" } });
      next();
    });
    app.use("/api/integrations", createWorkspaceConnectionRoutes(service));
  });

  afterEach(() => sqlite.close());

  test("drives start, callback, status and disconnect without exposing callback or token secrets", async () => {
    const start = await request(app).get("/api/integrations/github/start");
    expect(start.status).toBe(303);
    const authorizationUrl = new URL(start.headers.location);
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBe("vertical_state_abcdefghijklmnopqrstuvwxyz0123456789");

    const callbackCode = "vertical-callback-code-secret";
    const callback = await request(app).get(
      `/api/integrations/github/callback?code=${callbackCode}&state=${state}`,
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe(
      "https://moira.example.com/app/settings?github=connected#integrations-github",
    );
    expect(`${callback.headers.location}\n${callback.text}`).not.toMatch(
      /vertical-callback-code-secret|vertical_state_|ghu_vertical|ghr_vertical/,
    );
    expect(github.exchangedCode).toBe(callbackCode);

    const status = await request(app).get("/api/integrations/github");
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({
      state: "connected",
      account: { id: "25282049", login: "witqq" },
      repositories: [{ fullName: "witqq/private-project", private: true }],
    });
    expect(JSON.stringify(status.body)).not.toMatch(
      /vertical-callback-code-secret|vertical_state_|ghu_vertical|ghr_vertical|connectionId/,
    );

    const persisted = JSON.stringify({
      connection: sqlite.prepare("SELECT * FROM workspaceConnection").all(),
      vault: sqlite.prepare("SELECT * FROM workspaceCredentialVault").all(),
    });
    expect(persisted).not.toMatch(
      /vertical-callback-code-secret|vertical_state_|ghu_vertical|ghr_vertical|vertical-web-session/,
    );

    const disconnect = await request(app).delete("/api/integrations/github");
    expect(disconnect.status).toBe(200);
    expect(disconnect.body.data).toMatchObject({ state: "disconnected" });
    expect(github.revokedGrantToken).toBe("ghu_vertical-access-secret");
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialVault").all()).toEqual([]);
  });
});
