import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createWorkflowCliFixture } from "../../helpers/workflow-cli-fixture.js";

let cli: ReturnType<typeof createWorkflowCliFixture>;

function run(args: string[]): string {
  return cli.run(args);
}

function fixture(): string {
  const file = cli.path(`workflow-progress-${randomUUID()}.json`);
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
          connections: { default: "user-notify" },
        },
        {
          id: "user-notify",
          type: "user-notification",
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
    cli = createWorkflowCliFixture("workflow-progress-");
    file = fixture();
  });

  afterEach(() => {
    cli.cleanup();
  });

  test("authors and clears the complete static progress graph from a file", () => {
    const progressFile = cli.path(`progress-${randomUUID()}.json`);
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

  test("sets and clears node mappings and legacy plus portable notification attachments", () => {
    run([
      file,
      "update",
      "task",
      "--progress-node-id",
      "work",
      "--progress-active-label",
      "Implement {{unit}}/3",
      "--progress-active-content",
      '{"summary":"Implement API","next":"Review"}',
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
    run([
      file,
      "update",
      "user-notify",
      "--progress-node-id",
      "work",
      "--attach-progress-image",
      "true",
    ]);
    let workflow = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(workflow.nodes.find((node: { id: string }) => node.id === "task")).toMatchObject({
      progressNodeId: "work",
      progressActiveLabel: "Implement {{unit}}/3",
      progressActiveContent: { summary: "Implement API", next: "Review" },
    });
    expect(workflow.nodes.find((node: { id: string }) => node.id === "notify")).toMatchObject({
      progressNodeId: "work",
      attachProgressImage: true,
    });
    expect(workflow.nodes.find((node: { id: string }) => node.id === "user-notify")).toMatchObject({
      progressNodeId: "work",
      attachProgressImage: true,
    });

    run([file, "update", "task", "--progress-active-label", "none"]);
    run([file, "update", "task", "--progress-active-content", "none"]);
    run([file, "update", "task", "--progress-node-id", "none"]);
    run([file, "update", "notify", "--attach-progress-image", "false"]);
    run([file, "update", "user-notify", "--attach-progress-image", "false"]);
    workflow = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(workflow.nodes.find((node: { id: string }) => node.id === "task")).not.toHaveProperty(
      "progressNodeId",
    );
    expect(workflow.nodes.find((node: { id: string }) => node.id === "task")).not.toHaveProperty(
      "progressActiveLabel",
    );
    expect(workflow.nodes.find((node: { id: string }) => node.id === "task")).not.toHaveProperty(
      "progressActiveContent",
    );
    expect(workflow.nodes.find((node: { id: string }) => node.id === "notify")).not.toHaveProperty(
      "attachProgressImage",
    );
    expect(
      workflow.nodes.find((node: { id: string }) => node.id === "user-notify"),
    ).not.toHaveProperty("attachProgressImage");
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

  test("rejects active content on transient nodes and without a milestone mapping", () => {
    expect(() =>
      run([file, "update", "start", "--progress-active-content", '{"summary":"Starting"}']),
    ).toThrow();
    expect(() =>
      run([file, "update", "task", "--progress-active-content", '{"summary":"Work"}']),
    ).toThrow();
  });
});
