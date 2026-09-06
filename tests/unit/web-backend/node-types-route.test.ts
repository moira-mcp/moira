/**
 * The endpoint the browser asks about node types.
 *
 * Its job is to answer from this process's own knowledge — the engine's built-in list and the live
 * extension registry validation already uses. The wrong state it must exclude is an endpoint that
 * answers from a list of its own: such an endpoint looks correct on an installation with no
 * extensions and reports every custom node as unknown on one that has them.
 */

import { describe, expect, test, jest } from "@jest/globals";
import express from "express";
import request from "supertest";

process.env.DB_PATH = ":memory:";

const catalog = {
  nodeTypes: [
    {
      type: "corporate-messenger.send",
      title: "Отправка сообщения",
      description: "Sends a message to the configured recipient.",
      origin: "extension",
      extensionName: "corporate-messenger",
      extensionVersion: "2.1.0",
      schema: { type: "object", required: ["text"] },
      schemaScope: "config",
    },
  ],
  extensionsAvailable: true,
};

const buildNodeTypeCatalog = jest.fn(() => catalog);
const getActiveExtensionRegistry = jest.fn(() => null as unknown);

jest.unstable_mockModule("@mcp-moira/workflow-engine", () => ({
  buildNodeTypeCatalog,
  getActiveExtensionRegistry,
}));

const { nodeTypesRoutes } = await import("../../../packages/web-backend/src/routes/node-types.js");

function app() {
  const application = express();
  application.use(express.json());
  application.use("/api/node-types", nodeTypesRoutes);
  return application;
}

describe("GET /api/node-types", () => {
  test("answers with the catalog built from this process's registry", async () => {
    // Required state: the endpoint composes the engine's catalog over the registry this process
    // holds. Plausible wrong state: it assembles its own list of "the types we know", which drifts
    // from the engine exactly as the visualization check once drifted over `materialize`.
    const response = await request(app()).get("/api/node-types");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(catalog);
  });
});
