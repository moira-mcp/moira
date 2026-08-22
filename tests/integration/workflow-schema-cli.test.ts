import { afterEach, describe, expect, test } from "@jest/globals";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const CLI = path.join(process.cwd(), "packages/workflow-cli/src/workflow-tool.ts");
const temporaryDirectories: string[] = [];

function temporaryWorkflow(workflow: WorkflowGraph): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-workflow-schema-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "workflow.json");
  fs.writeFileSync(file, JSON.stringify(workflow, null, 2));
  return file;
}

function hasTerminalControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code <= 0x09 ||
      (code >= 0x0b && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    );
  });
}

afterEach(() => {
  temporaryDirectories
    .splice(0)
    .forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
});

describe("moira-workflow schema command", () => {
  test("should print the single schema document and not write the source", () => {
    const workflow: WorkflowGraph = {
      metadata: { name: "CLI fixture", version: "1.0.0", description: "" },
      nodes: [
        { id: "start", type: "start", connections: { default: "route" } },
        {
          id: "route",
          type: "condition",
          condition: { operator: "eq", left: { contextPath: "answer" }, right: true },
          connections: { true: "end", false: "end" },
        },
        { id: "end", type: "end" },
      ],
    };
    const file = temporaryWorkflow(workflow);
    const before = fs.readFileSync(file, "utf8");

    const output = execFileSync(process.execPath, ["--import", "tsx", CLI, file, "schema"], {
      encoding: "utf8",
    });
    const structureOutput = execFileSync(
      process.execPath,
      ["--import", "tsx", CLI, file, "structure", "--graph"],
      { encoding: "utf8" },
    );

    expect(output).toContain("WORKFLOW CLI fixture v1.0.0");
    expect(output.match(/^ {2}NODE /gm)).toHaveLength(3);
    expect(output.match(/^ {4}EDGE /gm)).toHaveLength(3);
    expect(output).toContain("COVERAGE nodes=3/3 edges=3/3");
    expect(structureOutput).toContain(output.trim());
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  test("should produce identical output for permuted connection keys", () => {
    const common = {
      metadata: { name: "Canonical", version: "1.0.0", description: "" },
    };
    const left = temporaryWorkflow({
      ...common,
      nodes: [
        { id: "start", type: "start", connections: { default: "route" } },
        {
          id: "route",
          type: "condition",
          condition: { operator: "exists", value: { contextPath: "answer" } },
          connections: { true: "end", false: "end" },
        },
        { id: "end", type: "end" },
      ],
    });
    const right = temporaryWorkflow({
      ...common,
      nodes: [
        { id: "start", type: "start", connections: { default: "route" } },
        {
          id: "route",
          type: "condition",
          condition: { value: { contextPath: "answer" }, operator: "exists" },
          connections: { false: "end", true: "end" },
        },
        { id: "end", type: "end" },
      ],
    });

    const execute = (file: string): string =>
      execFileSync(process.execPath, ["--import", "tsx", CLI, file, "schema"], {
        encoding: "utf8",
      });

    expect(execute(left)).toBe(execute(right));
  });

  test("should return a non-zero status for an ambiguous duplicate-id graph", () => {
    const file = temporaryWorkflow({
      metadata: { name: "Bad", version: "1.0.0", description: "" },
      nodes: [
        { id: "same", type: "end" },
        { id: "same", type: "end" },
      ],
    });

    const result = spawnSync(process.execPath, ["--import", "tsx", CLI, file, "schema"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Duplicate node IDs prevent an unambiguous schema: same");
  });

  test("should escape terminal controls decoded from workflow JSON", () => {
    const file = temporaryWorkflow({
      metadata: {
        name: "Unsafe\u001b]0;title\u0007\u009b",
        version: "1.0.0",
        description: "",
      },
      nodes: [
        {
          id: "start\u001b[31mINJECT",
          type: "start",
          connections: { "go\u001b]0;INJECT\u0007": "end" },
        },
        { id: "end", type: "end" },
      ],
    });

    const output = execFileSync(process.execPath, ["--import", "tsx", CLI, file, "schema"], {
      encoding: "utf8",
    });

    expect(output).toContain('START_ENTRIES "start\\u001b[31mINJECT"');
    expect(output).toContain('["go\\u001b]0;INJECT\\u0007"] -> end');
    expect(hasTerminalControl(output)).toBe(false);
  });
});
