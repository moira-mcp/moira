import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

const WORKFLOW_TOOL = path.join(process.cwd(), "packages/workflow-cli/bin/moira-workflow.js");

/** The tool's output without its terminal colours. */
function run(args: string[]): string {
  return stripVTControlCharacters(
    execFileSync(process.execPath, [WORKFLOW_TOOL, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

const APPROVAL = {
  label: "Approve the import mapping",
  when: { operator: "neq", left: { contextPath: "operating_mode" }, right: "autonomous" },
  notify: "off",
  remindAfter: "1d",
};

function workflow(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function nodeOf(file: string, id: string): Record<string, unknown> {
  return workflow(file).nodes.find((node: { id: string }) => node.id === id);
}

function fixture(): string {
  const file = path.join(os.tmpdir(), `workflow-human-gate-${randomUUID()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      metadata: { name: "Order import", version: "1.0.0", description: "Import orders from CSV" },
      variableRegistry: {
        operating_mode: { type: "string", description: "Interactive or autonomous" },
      },
      nodes: [
        { id: "start", type: "start", connections: { default: "approve" } },
        {
          id: "approve",
          type: "agent-directive",
          directive: "Show the column mapping and ask the person to approve it",
          completionCondition: "Decided",
          connections: { success: "notify" },
        },
        {
          id: "notify",
          type: "user-notification",
          message: "Imported",
          connections: { default: "end" },
        },
        { id: "end", type: "end" },
      ],
    }),
  );
  return file;
}

describe("workflow-tool human gate authoring", () => {
  let file: string;
  let other: string;

  beforeEach(() => {
    file = fixture();
    other = fixture();
  });

  afterEach(() => {
    fs.rmSync(file, { force: true });
    fs.rmSync(other, { force: true });
  });

  test("marks, replaces and unmarks a step, bumping the version each time", () => {
    run([file, "update", "approve", "--human-gate", JSON.stringify(APPROVAL)]);
    expect(nodeOf(file, "approve").humanGate).toEqual(APPROVAL);
    expect(workflow(file).metadata.version).toBe("1.0.1");

    run([file, "update", "approve", "--human-gate", '{"label":"Approve the mapping"}']);
    expect(nodeOf(file, "approve").humanGate).toEqual({ label: "Approve the mapping" });

    run([file, "update", "approve", "--human-gate", "none"]);
    expect(nodeOf(file, "approve")).not.toHaveProperty("humanGate");
    expect(workflow(file).metadata.version).toBe("1.0.3");
  });

  test.each([
    ["malformed JSON", "{label:"],
    ["a list instead of an object", "[]"],
    ["an unknown field", '{"label":"Approve","answer":"yes"}'],
    ["an empty label", '{"label":" "}'],
    ["a label longer than 120 characters", JSON.stringify({ label: "a".repeat(121) })],
    ["an unknown notify value", '{"notify":"sometimes"}'],
    ["a duration without a unit", '{"remindAfter":"24"}'],
    ["a condition that is not an object", '{"when":"operating_mode"}'],
  ])("refuses %s and leaves the file unchanged", (_case, value) => {
    const before = fs.readFileSync(file, "utf8");
    expect(() => run([file, "update", "approve", "--human-gate", value])).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  test("refuses a node that is not an agent-directive", () => {
    const before = fs.readFileSync(file, "utf8");
    expect(() => run([file, "update", "notify", "--human-gate", '{"label":"x"}'])).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  test("get, schema, structure and diff show the mark only where it is set", () => {
    const unmarked = {
      get: run([file, "get", "approve"]),
      schema: run([file, "schema"]),
      structure: run([file, "structure"]),
    };
    run([file, "update", "approve", "--human-gate", JSON.stringify(APPROVAL)]);

    expect(unmarked.get).not.toContain("humanGate");
    expect(run([file, "get", "approve"])).toContain('"remindAfter": "1d"');

    expect(unmarked.schema).not.toContain("HUMAN_GATE");
    expect(run([file, "schema"])).toMatch(
      /NODE approve \[agent-directive\][\s\S]*HUMAN_GATE .*"notify":"off"/,
    );

    expect(unmarked.structure).not.toContain("Human gate:");
    expect(run([file, "structure"])).toContain('Human gate: {"label":"Approve the import mapping"');

    expect(run([other, "diff", other])).not.toContain("humanGate");
    expect(run([other, "diff", file])).toMatch(/approve.*humanGate/);
  });
});
