import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const WORKFLOW_TOOL = path.join(process.cwd(), "packages/workflow-cli/bin/moira-workflow.js");

function run(args: string[]): string {
  return execFileSync(process.execPath, [WORKFLOW_TOOL, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function read(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** A two-block process with one unlabelled boundary edge and one unowned routing node. */
function fixture(): string {
  const file = path.join(os.tmpdir(), `workflow-process-${randomUUID()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      metadata: { name: "Process", version: "1.2.3", description: "Process fixture" },
      variableRegistry: {
        progress_work_outcome: { type: "string", description: "Work outcome" },
      },
      progress: {
        nodes: [
          {
            id: "work",
            label: "Work",
            content: { summary: "Do the work", outcome: "{{progress_work_outcome}}" },
          },
          { id: "check", label: "Check", content: { summary: "Check the work" } },
        ],
      },
      nodes: [
        { id: "start", type: "start", progressNodeId: "work", connections: { default: "do" } },
        {
          id: "do",
          type: "agent-directive",
          progressNodeId: "work",
          directive: "Do",
          completionCondition: "Done",
          inputSchema: { type: "object", properties: {}, globalInputs: ["progress_work_outcome"] },
          connections: { success: "verify" },
        },
        {
          id: "verify",
          type: "condition",
          cases: [
            {
              when: { operator: "eq", left: { contextPath: "do.ok" }, right: true },
              output: "true",
            },
          ],
          connections: { true: "end", default: "do" },
        },
        { id: "end", type: "end", progressNodeId: "check" },
      ],
    }),
  );
  return file;
}

describe("workflow-tool process block authoring", () => {
  let file: string;

  beforeEach(() => {
    file = fixture();
  });

  afterEach(() => {
    fs.rmSync(file, { force: true });
  });

  test("labels a forward edge and an explained return, moves a node, and the contract becomes satisfied", () => {
    run([file, "set-label", "do", "success", "work done", "--no-version-bump"]);
    expect(read(file).nodes[1].connectionLabels).toEqual({ success: "work done" });
    expect(read(file).metadata.version).toBe("1.2.3");

    run([file, "set-block", "verify", "check", "--no-version-bump"]);
    expect(read(file).nodes[2].progressNodeId).toBe("check");

    const output = run([
      file,
      "set-label",
      "verify",
      "default",
      "check failed",
      "--cause",
      "The check found a problem",
      "--exit",
      "The check passes",
      "--no-version-bump",
    ]);
    expect(read(file).nodes[2].connectionLabels).toEqual({
      default: {
        label: "check failed",
        cycle: { cause: "The check found a problem", exit: "The check passes" },
      },
    });
    expect(output).toContain("Process block contract satisfied");
    expect(run([file, "derive"])).toContain("DIAGNOSTICS: none");
  });

  test("reports remaining diagnostics after a partial annotation without refusing the write", () => {
    const output = run([file, "set-label", "do", "success", "work done", "--no-version-bump"]);
    // The unowned node and, because it was the block's only step, the block it left unconnected.
    expect(output).toMatch(/2 block-contract diagnostics remain/);
    const derived = run([file, "derive"]);
    expect(derived).toContain("unowned-node node=verify");
    expect(derived).toContain("unconnected-block");
  });

  test("bumps the patch version unless --no-version-bump or --force is given", () => {
    run([file, "set-label", "do", "success", "work done"]);
    expect(read(file).metadata.version).toBe("1.2.4");
    run([file, "clear-label", "do", "success", "--force"]);
    expect(read(file).metadata.version).toBe("1.2.4");
    expect(read(file).nodes[1]).not.toHaveProperty("connectionLabels");
  });

  test("binds a block to a list, rejects a malformed binding, and removes it with none", () => {
    run([
      file,
      "edit-block",
      "work",
      "--list",
      '{"current":"progress_work_outcome","total":"progress_work_outcome"}',
      "--no-version-bump",
    ]);
    expect(read(file).progress.nodes[0].list).toEqual({
      current: "progress_work_outcome",
      total: "progress_work_outcome",
    });
    expect(() =>
      run([file, "edit-block", "work", "--list", '{"title":"name"}', "--no-version-bump"]),
    ).toThrow(/at least one of items, current or total/u);
    expect(read(file).progress.nodes[0].list).toBeDefined();
    run([
      file,
      "add-block",
      "deliver",
      "Deliver",
      "Hand over",
      "--list",
      '{"items":"progress_work_outcome","indexBase":0}',
      "--no-version-bump",
    ]);
    expect(read(file).progress.nodes[2].list).toEqual({
      items: "progress_work_outcome",
      indexBase: 0,
    });
    // The deterministic schema names the binding on its block.
    expect(run([file, "schema"])).toMatch(
      /PROGRESS_NODE deliver[^\n]*\n(?:[^\n]*\n)*? {4}LIST \{"indexBase":0,"items":"progress_work_outcome"\}/u,
    );
    run([file, "edit-block", "work", "--list", "none", "--no-version-bump"]);
    expect(read(file).progress.nodes[0].list).toBeUndefined();
  });

  test("adds a block after another and edits its description and outcome", () => {
    run([
      file,
      "add-block",
      "deliver",
      "Deliver",
      "Hand the result over",
      "--after",
      "work",
      "--next",
      "Check",
      "--no-version-bump",
    ]);
    expect(read(file).progress.nodes.map((b: { id: string }) => b.id)).toEqual([
      "work",
      "deliver",
      "check",
    ]);
    expect(read(file).progress.nodes[1].content).toEqual({
      summary: "Hand the result over",
      next: "Check",
    });

    run([
      file,
      "edit-block",
      "deliver",
      "--label",
      "Deliver result",
      "--summary",
      "Present the result",
      "--outcome",
      "{{progress_work_outcome}}",
      "--next",
      "none",
      "--no-version-bump",
    ]);
    expect(read(file).progress.nodes[1].label).toBe("Deliver result");
    expect(read(file).progress.nodes[1].content).toEqual({
      summary: "Present the result",
      outcome: "{{progress_work_outcome}}",
    });
  });

  test.each([
    ["an unknown node", ["set-label", "ghost", "success", "x"]],
    ["an unknown connection key", ["set-label", "do", "failure", "x"]],
    ["a return with only a cause", ["set-label", "verify", "default", "x", "--cause", "c"]],
    ["moving a node to an unknown block", ["set-block", "do", "ghost"]],
    ["a duplicate block id", ["add-block", "work", "Work", "Again"]],
    ["editing an unknown block", ["edit-block", "ghost", "--summary", "x"]],
    ["an empty summary", ["edit-block", "work", "--summary", " "]],
  ])("refuses %s and leaves the file unchanged", (_name, command) => {
    const before = fs.readFileSync(file, "utf8");
    expect(() => run([file, ...command, "--no-version-bump"])).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
