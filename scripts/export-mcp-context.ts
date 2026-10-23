#!/usr/bin/env node

/**
 * Export the static MCP tool contract, including declared description variants.
 * This is not the effective database instructions or a live OAuth/model session.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getToolContractProjection, MCP_TOOLS_REVISION } from "@mcp-moira/mcp-server/tool-contract";

const output = {
  exportDate: new Date().toISOString(),
  scope: "static-tool-contract",
  toolsRevision: MCP_TOOLS_REVISION,
  tools: getToolContractProjection(),
};

const outputPath = join(process.cwd(), "mcp-tools-context.json");
writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log("Exported static MCP tool contract (not effective session instructions).");
console.log(`Tools revision: ${MCP_TOOLS_REVISION}`);
console.log(`Output written to: ${outputPath}`);
