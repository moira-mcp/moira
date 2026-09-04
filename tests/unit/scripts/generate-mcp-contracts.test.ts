import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateMcpContracts,
  getGeneratedMcpContractFiles,
} from "../../../scripts/generate-mcp-contracts.js";

describe("MCP contract generation", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "moira-mcp-contracts-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("writes every declared target and accepts the fresh result", () => {
    generateMcpContracts(projectRoot, false);

    const generated = getGeneratedMcpContractFiles(projectRoot);
    expect([...generated.keys()]).toHaveLength(3);
    for (const [filePath, expected] of generated) {
      expect(readFileSync(filePath, "utf8")).toBe(expected);
    }
    expect(() => generateMcpContracts(projectRoot, true)).not.toThrow();

    const english = readFileSync(
      join(projectRoot, "packages/docs/src/fragments/mcp-tools.en.md"),
      "utf8",
    );
    const russian = readFileSync(
      join(projectRoot, "packages/docs/src/fragments/mcp-tools.ru.md"),
      "utf8",
    );
    expect(english).toContain("## MCP tools");
    expect(english).not.toMatch(/^# /m);
    expect(russian).toContain("## Инструменты MCP");
    expect(russian).not.toMatch(/^# /m);
  });

  it("rejects changed and missing generated targets", () => {
    generateMcpContracts(projectRoot, false);
    const englishPath = join(projectRoot, "packages/docs/src/fragments/mcp-tools.en.md");
    writeFileSync(englishPath, "stale", "utf8");
    expect(() => generateMcpContracts(projectRoot, true)).toThrow(englishPath);

    generateMcpContracts(projectRoot, false);
    const russianPath = join(projectRoot, "packages/docs/src/fragments/mcp-tools.ru.md");
    unlinkSync(russianPath);
    expect(() => generateMcpContracts(projectRoot, true)).toThrow(russianPath);
  });
});
