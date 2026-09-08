import { describe, expect, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import { requestLogger, sanitizeRequestUrl, type ServiceLogger } from "@mcp-moira/shared";

describe("sanitizeRequestUrl", () => {
  test("redacts materialize grants while preserving routing and query context", () => {
    expect(
      sanitizeRequestUrl("/api/public/executions/materialize/secret-token-value?download=true"),
    ).toBe("/api/public/executions/materialize/[REDACTED]?download=true");
  });

  test("does not alter unrelated URLs", () => {
    expect(sanitizeRequestUrl("/api/workflows/example")).toBe("/api/workflows/example");
  });

  test("redacts progress image grants including filename suffixes", () => {
    expect(
      sanitizeRequestUrl("/api/public/execution-progress-image/secret-token?download=true"),
    ).toBe("/api/public/execution-progress-image/[REDACTED]?download=true");
  });

  test("redacts GitHub callback code and state as one sensitive query", () => {
    const safe = sanitizeRequestUrl(
      "/api/integrations/github/callback?code=github-secret-code&state=browser-secret-state",
    );
    expect(safe).toBe("/api/integrations/github/callback?[REDACTED]");
    expect(safe).not.toMatch(/github-secret-code|browser-secret-state/);
  });

  test("request logger emits the redacted URL rather than the materialize grant", async () => {
    const messages: string[] = [];
    const logger = {
      info: (message: string) => messages.push(message),
    } as unknown as ServiceLogger;
    const app = express();
    app.use(requestLogger({ logger }));
    app.get("/api/public/executions/materialize/:token", (_req, res) => res.sendStatus(204));
    app.get("/api/workflows/:id", (_req, res) => res.sendStatus(204));

    await request(app).get("/api/public/executions/materialize/secret-grant").expect(204);
    expect(messages.join("\n")).toContain("/api/public/executions/materialize/[REDACTED]");
    expect(messages.join("\n")).not.toContain("secret-grant");

    messages.length = 0;
    await request(app).get("/api/workflows/example").expect(204);
    expect(messages.join("\n")).toContain("/api/workflows/example");
  });
});
