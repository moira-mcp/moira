import { describe, expect, it } from "@jest/globals";

import { evaluateMcpToolsRevision } from "../../../packages/mcp-server/src/auth/mcp-tools-revision.js";
import { MCP_TOOLS_REVISION } from "../../../packages/mcp-server/src/tools/tool-definitions.js";

describe("MCP tools revision contract", () => {
  it("accepts only the current contract revision and returns HTTP 426 details otherwise", () => {
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
