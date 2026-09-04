import { describe, expect, it } from "@jest/globals";

import {
  MCP_TOOLS_REVISION,
  evaluateMcpToolsRevision,
} from "../../../packages/shared/src/config/index.js";

describe("MCP tools revision contract", () => {
  it("accepts only the generated revision and returns the HTTP 426 body for null or stale OAuth tokens", () => {
    expect(evaluateMcpToolsRevision(MCP_TOOLS_REVISION, "1.3.0")).toEqual({ accepted: true });

    expect(evaluateMcpToolsRevision(null, "1.3.0")).toEqual({
      accepted: false,
      status: 426,
      body: expect.objectContaining({
        error: "upgrade_required",
        serverVersion: "1.3.0",
        toolsRevision: MCP_TOOLS_REVISION,
        clientVersion: "unknown",
      }),
    });

    expect(evaluateMcpToolsRevision("stale-revision", "1.3.0")).toEqual({
      accepted: false,
      status: 426,
      body: expect.objectContaining({
        error: "upgrade_required",
        toolsRevision: MCP_TOOLS_REVISION,
        clientVersion: "stale-revision",
      }),
    });
  });
});
