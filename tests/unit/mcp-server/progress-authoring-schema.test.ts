import { describe, expect, test } from "@jest/globals";
import { progressAuthoringSchema } from "../../../packages/mcp-server/src/schemas/progress-authoring.js";

const richProgress = {
  title: "Development",
  goal: "Show the complete execution state",
  facts: [
    { label: "Mode", value: "{{mode}}", tone: "neutral" },
    { label: "Attention", value: "{{attention}}", tone: "positive" },
  ],
  nodes: [
    {
      id: "plan",
      label: "Plan {{revision}}",
      content: {
        summary: "Current plan",
        details: ["Core", "UI"],
        outcome: "Accepted",
        next: "Implement",
      },
      connections: { default: "implement" },
    },
    { id: "implement", label: "Implement" },
  ],
};

describe("MCP rich progress authoring schema", () => {
  test("accepts the complete generic progress presentation used by manage create/edit", () => {
    expect(progressAuthoringSchema.parse(richProgress)).toEqual(richProgress);
  });

  test.each([
    ["unknown top-level field", { ...richProgress, plan: "private vocabulary" }],
    [
      "too many facts",
      { ...richProgress, facts: Array.from({ length: 9 }, () => ({ label: "x", value: "y" })) },
    ],
    [
      "oversized detail",
      {
        ...richProgress,
        nodes: [{ ...richProgress.nodes[0], content: { details: ["x".repeat(501)] } }],
      },
    ],
    [
      "unknown milestone content",
      {
        ...richProgress,
        nodes: [{ ...richProgress.nodes[0], content: { hiddenHtml: "<b>x</b>" } }],
      },
    ],
    ["empty title", { ...richProgress, title: "" }],
    ["empty goal", { ...richProgress, goal: "" }],
    ["empty nodes", { ...richProgress, nodes: [] }],
    ["empty node id", { ...richProgress, nodes: [{ id: "", label: "Stage" }] }],
    ["empty label", { ...richProgress, nodes: [{ id: "stage", label: "" }] }],
    [
      "empty connection",
      {
        ...richProgress,
        nodes: [{ id: "stage", label: "Stage", connections: { default: "" } }],
      },
    ],
    ["empty content", { ...richProgress, nodes: [{ id: "stage", label: "Stage", content: {} }] }],
  ])("rejects %s", (_name, value) => {
    expect(progressAuthoringSchema.safeParse(value).success).toBe(false);
  });
});
