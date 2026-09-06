/**
 * The node-type catalog as the browser actually receives it: through the real route, over HTTP,
 * with the real engine behind it.
 *
 * The unit observations check the catalog and the route separately. What neither can show is that
 * the process the browser talks to answers from the same registry validation uses: a route wired to
 * a fresh empty registry passes every unit observation and reports every custom node as unknown on
 * a real installation.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  ExtensionRegistry,
  EXTENSION_API_VERSION,
  setActiveExtensionRegistry,
} from "@mcp-moira/workflow-engine";
import type { ExtensionManifest } from "@mcp-moira/workflow-engine";
import { nodeTypesRoutes } from "../../packages/web-backend/src/routes/node-types.js";

const MANIFEST: ExtensionManifest = {
  apiVersion: EXTENSION_API_VERSION,
  name: "catalog-probe",
  version: "3.4.5",
  entrypoint: "index.js",
  nodes: [
    {
      type: "catalog-probe.emit",
      title: "Испустить событие",
      description: "Emits a probe event.",
      configSchema: {
        type: "object",
        required: ["channel"],
        properties: { channel: { type: "string" } },
      },
      outputSchema: { type: "object" },
    },
  ],
  settings: [{ key: "catalog-probe.token", type: "encrypted", label: "Token" }],
};

function app() {
  const application = express();
  application.use("/api/node-types", nodeTypesRoutes);
  return application;
}

describe("GET /api/node-types over the real route", () => {
  beforeAll(() => {
    const registry = new ExtensionRegistry("live");
    const result = registry.register(MANIFEST);
    expect(result.registered).toBe(true);
    setActiveExtensionRegistry(registry);
  });

  afterAll(() => {
    setActiveExtensionRegistry(null);
  });

  test("returns built-in and installed extension types with their declarations", async () => {
    const response = await request(app()).get("/api/node-types");

    expect(response.status).toBe(200);
    const types: Array<{ type: string; title: string; extensionName?: string }> =
      response.body.data.nodeTypes;
    const byType = new Map(types.map((entry) => [entry.type, entry]));

    // The extension's own title travels: it is not derivable from the type string.
    expect(byType.get("catalog-probe.emit")).toMatchObject({
      title: "Испустить событие",
      origin: "extension",
      extensionName: "catalog-probe",
      extensionVersion: "3.4.5",
      schemaScope: "config",
    });
    // Built-in types the browser bundle never listed are here too.
    expect(byType.get("lock")?.origin).toBe("builtin");
    expect(byType.get("teleport")?.origin).toBe("builtin");
    expect(response.body.data.extensionsAvailable).toBe(true);
  });

  test("the response carries no setting keys or values", async () => {
    const response = await request(app()).get("/api/node-types");

    expect(JSON.stringify(response.body)).not.toContain("catalog-probe.token");
  });

  test("without a live registry the built-in types still answer, and absence is not claimed", async () => {
    setActiveExtensionRegistry(null);

    const response = await request(app()).get("/api/node-types");

    expect(response.status).toBe(200);
    expect(response.body.data.extensionsAvailable).toBe(false);
    const types: Array<{ type: string }> = response.body.data.nodeTypes;
    expect(types.some((entry) => entry.type === "agent-directive")).toBe(true);
    expect(types.some((entry) => entry.type === "catalog-probe.emit")).toBe(false);
  });
});
