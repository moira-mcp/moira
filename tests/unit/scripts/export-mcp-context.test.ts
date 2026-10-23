import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getToolContractProjection,
  MCP_TOOLS_REVISION,
} from "../../../packages/mcp-server/src/tools/tool-definitions.js";

const exporter = resolve("scripts/export-mcp-context.ts");
const tsx = resolve("node_modules/.bin/tsx");

describe("MCP context exporter", () => {
  it("writes the complete static contract and revision from a different working directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "moira-tool-contract-export-"));
    try {
      const result = spawnSync(tsx, [exporter], {
        cwd: directory,
        env: { ...process.env, NODE_OPTIONS: "" },
        encoding: "utf8",
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      const output = JSON.parse(readFileSync(join(directory, "mcp-tools-context.json"), "utf8"));
      expect(output).toEqual({
        exportDate: expect.any(String),
        scope: "static-tool-contract",
        toolsRevision: MCP_TOOLS_REVISION,
        tools: getToolContractProjection(),
      });
      expect(new Date(output.exportDate).toISOString()).toBe(output.exportDate);
      expect(result.stdout).toContain("not effective session instructions");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
