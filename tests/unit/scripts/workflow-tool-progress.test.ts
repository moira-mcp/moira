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

function fixture(): string {
  const file = path.join(os.tmpdir(), `workflow-progress-${randomUUID()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      metadata: { name: "Progress", version: "1.0.0", description: "Progress fixture" },
      nodes: [
        { id: "start", type: "start", connections: { default: "task" } },
        {
          id: "task",
          type: "agent-directive",
          directive: "Do the task",
          completionCondition: "Done",
          connections: { success: "notify" },
        },
        {
          id: "notify",
          type: "telegram-notification",
          message: "Ready",
          connections: { default: "end" },
        },
        { id: "end", type: "end" },
      ],
    }),
  );
  return file;
}

describe("workflow-tool progress authoring", () => {
  let file: string;

  beforeEach(() => {
    file = fixture();
  });

  afterEach(() => {
    fs.rmSync(file, { force: true });
  });

  test("authors and clears the complete static progress graph from a file", () => {
    const progressFile = path.join(os.tmpdir(), `progress-${randomUUID()}.json`);
    const progress = {
      title: "Task {{executionId}}",
      nodes: [{ id: "work", label: "Work" }],
    };
    fs.writeFileSync(progressFile, JSON.stringify(progress));
    try {
      run([file, "set-progress", "--file", progressFile]);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).progress).toEqual(progress);

      run([file, "set-progress", "none"]);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).not.toHaveProperty("progress");
    } finally {
      fs.rmSync(progressFile, { force: true });
    }
  });

  test("rejects malformed progress input without changing the stored graph", () => {
    expect(() => run([file, "set-progress", '{"title":"Missing nodes"}'])).toThrow();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).not.toHaveProperty("progress");
  });

  test("sets and clears node mappings and Telegram attachments", () => {
    run([
      file,
      "update",
      "task",
      "--progress-node-id",
      "work",
      "--progress-active-label",
      "Implement {{unit}}/3",
    ]);
    run([
      file,
      "update",
      "notify",
      "--progress-node-id",
      "work",
      "--attach-progress-image",
      "true",
    ]);
    let workflow = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(workflow.nodes.find((node: { id: string }) => node.id === "task")).toMatchObject({
      progressNodeId: "work",
      progressActiveLabel: "Implement {{unit}}/3",
    });
    expect(workflow.nodes.find((node: { id: string }) => node.id === "notify")).toMatchObject({
      progressNodeId: "work",
      attachProgressImage: true,
    });

    run([file, "update", "task", "--progress-active-label", "none"]);
    run([file, "update", "task", "--progress-node-id", "none"]);
    run([file, "update", "notify", "--attach-progress-image", "false"]);
    workflow = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(workflow.nodes.find((node: { id: string }) => node.id === "task")).not.toHaveProperty(
      "progressNodeId",
    );
    expect(workflow.nodes.find((node: { id: string }) => node.id === "task")).not.toHaveProperty(
      "progressActiveLabel",
    );
    expect(workflow.nodes.find((node: { id: string }) => node.id === "notify")).not.toHaveProperty(
      "attachProgressImage",
    );
  });

  test("rejects progress image attachment on a non-Telegram node", () => {
    expect(() => run([file, "update", "task", "--attach-progress-image", "true"])).toThrow();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).nodes[1]).not.toHaveProperty(
      "attachProgressImage",
    );
  });

  test("rejects active labels on transient nodes and without a milestone mapping", () => {
    expect(() => run([file, "update", "start", "--progress-active-label", "Starting"])).toThrow();
    expect(() => run([file, "update", "task", "--progress-active-label", "Implement"])).toThrow();
  });
});
