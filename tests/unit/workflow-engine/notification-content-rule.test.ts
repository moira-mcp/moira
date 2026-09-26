/**
 * A notification is read by a person who can open neither a file on the agent's machine nor a
 * step's raw output. The validator warns — never blocks — when a notification's message would show
 * a path or file, a bare counter with nothing naming what it counts, or a raw node output; and it
 * stays quiet for titled, linked and system values.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "@jest/globals";
import { GraphValidator, type WorkflowGraph } from "@mcp-moira/workflow-engine";

const FLOWS = path.join(process.cwd(), "workflows/production/flows");
const SDF = path.join(FLOWS, "91b11263-a180-4a08-9399-55f406f82c69.json");

function bundled(file: string): WorkflowGraph {
  return JSON.parse(fs.readFileSync(file, "utf8")) as WorkflowGraph;
}

async function warnings(graph: WorkflowGraph, nodeId: string) {
  const result = await new GraphValidator().validateUnified(graph);
  return {
    valid: result.valid,
    messages: result.issues
      .filter((issue) => issue.nodeId === nodeId && issue.severity === "warning")
      // Only this rule's warnings; the validator's other message checks have their own tests.
      .filter((issue) => issue.field === "message" && issue.message.startsWith("Notification "))
      .map((issue) => issue.message),
  };
}

/** A minimal graph with one notification whose message is `message`. */
function withMessage(
  message: string,
  type: "user-notification" | "telegram-notification" = "user-notification",
): WorkflowGraph {
  return {
    metadata: { name: "Notify", version: "1.0.0", description: "One notification" },
    variableRegistry: {
      report_path: { type: "string", description: "Where the report is" },
      output: { type: "string", description: "The file path of the generated report" },
      current_step_index: { type: "number", description: "Unit cursor" },
      plan_revision: { type: "number", description: "Plan revision" },
      max_retries: { type: "number", description: "Retry budget" },
      current_step: { type: "number", description: "Step cursor" },
      delivery_file: { type: "string", description: "Delivery" },
      work_dir: { type: "string", description: "Workspace" },
      unit_title: { type: "string", description: "The unit's title" },
      items: { type: "array", description: "Plan items" },
      goal: { type: "string", description: "The critical path to launch" },
      report_location: { type: "string", description: "Path to the file the report is in" },
      bucket: { type: "string", description: "Output folder of the run" },
    },
    nodes: [
      { id: "start", type: "start", connections: { default: "review" } },
      {
        id: "review",
        type: "agent-directive",
        directive: "Review",
        completionCondition: "Reviewed",
        inputSchema: {
          type: "object",
          properties: {
            verdict: { type: "string" },
            report_url: { type: "string" },
            unit_title: { type: "string" },
          },
        },
        connections: { success: "notify" },
      },
      { id: "notify", type, message, connections: { default: "end" } },
      { id: "end", type: "end" },
    ],
  } as unknown as WorkflowGraph;
}

describe("today's bundled messages that show internal values", () => {
  test.each([[SDF, "notify-unit-approval", "{{current_step_index}}", "a bare number"]])(
    "%#: %s warns on %s",
    async (file, nodeId, reference, kind) => {
      const { valid, messages } = await warnings(bundled(file), nodeId);
      expect(valid).toBe(true);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.stringMatching(new RegExp(`${reference.replace(/[{}]/gu, "\\$&")}, ${kind}`, "u")),
        ]),
      );
    },
  );
});

describe("what warns and what stays quiet", () => {
  test.each([
    ["a path-named variable", "Report: {{report_path}}", "{{report_path}}, a file or path"],
    [
      "a global its description calls a file path",
      "Output: {{output}}",
      "{{output}}, a file or path",
    ],
    ["a literal path", "See ./reports/final.md for details", 'the path "./reports/final.md"'],
    ["a home path", "Saved to ~/notes/today.txt", 'the path "~/notes/today.txt"'],
    [
      "a relative multi-segment path",
      "Details in final/delivery.md",
      'the path "final/delivery.md"',
    ],
    ["a parent-relative path", "See ../shared/notes.txt", 'the path "../shared/notes.txt"'],
    ["a path in parentheses", "Saved (src/app.ts) today", 'the path "src/app.ts"'],
    ["a path ending a sentence", "Details in final/delivery.md.", 'the path "final/delivery.md"'],
    [
      "a global described as a path to a file",
      "Report: {{report_location}}",
      "{{report_location}}, a file or path",
    ],
    ["a global described as a folder", "Stored in {{bucket}}", "{{bucket}}, a file or path"],
    [
      "a bare counter without a title",
      "Unit {{current_step_index}} is ready",
      "{{current_step_index}}, a bare number",
    ],
    ["a raw node output", "Verdict: {{review.verdict}}", "{{review.verdict}}, a step's raw output"],
  ])("warns on %s", async (_case, message, expected) => {
    const { valid, messages } = await warnings(withMessage(message), "notify");
    expect(valid).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(expected);
  });

  test.each([
    ["{{plan_revision}}", "a bare number"],
    ["{{max_retries}}", "a bare number"],
    ["{{current_step}}", "a bare number"],
    ["{{delivery_file}}", "a file or path"],
    ["{{work_dir}}", "a file or path"],
  ])("every name the rule knows warns: %s", async (reference, kind) => {
    const { messages } = await warnings(withMessage(`Now: ${reference}`), "notify");
    expect(messages).toEqual([expect.stringContaining(`${reference}, ${kind}`)]);
  });

  test.each([
    ["a counter with a title beside it", "Unit {{current_step_index}}: {{unit_title}} is ready"],
    ["a node output that is a URL", "The report: {{review.report_url}}"],
    ["a node output that is a title", "Finished {{review.unit_title}}"],
    ["system values", "Open the run: {{runUrl}} ({{executionId}})"],
    ["an each loop over titled items", "{{#each items}}- {{this.title}}\n{{/each}}"],
    ["a URL in the text", "Read https://moira.example/docs/guide.html first"],
    ["a count written in words", "2/3 units are done"],
    ["decimal fractions", "Coverage went from 1.2/1.3 to 0.5/1.5"],
    ["an abbreviation with a slash", "Use short names, e.g./i.e. forms"],
    ["a host without a scheme", "Mirror at www.example.com/page.html"],
    ["a description that is not about files", "Goal: {{goal}}"],
  ])("stays quiet for %s", async (_case, message) => {
    const { messages } = await warnings(withMessage(message), "notify");
    expect(messages).toEqual([]);
  });

  test("the deprecated telegram-notification is checked the same way", async () => {
    const { valid, messages } = await warnings(
      withMessage("Report: {{report_path}}", "telegram-notification"),
      "notify",
    );
    expect(valid).toBe(true);
    expect(messages).toEqual([expect.stringContaining("{{report_path}}, a file or path")]);
  });
});

describe("moira-workflow validate", () => {
  test("prints the warning and does not fail", () => {
    const file = path.join(os.tmpdir(), `notification-warning-${randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify(withMessage("Details: {{delivery_file}}")));
    try {
      const output = execFileSync(
        process.execPath,
        [path.join(process.cwd(), "packages/workflow-cli/bin/moira-workflow.js"), file, "validate"],
        { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(output).toContain("warning(s)");
      expect(output).toContain("Notification notify shows {{delivery_file}}");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
