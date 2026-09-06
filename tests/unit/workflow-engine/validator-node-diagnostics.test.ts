/**
 * Diagnostics for a node whose body breaks its schema.
 *
 * Two properties are held at once and pull in opposite directions:
 *  - every missing top-level required field of a node is named, so an author fixing a node does
 *    not learn about the second omission only after fixing the first;
 *  - the amount reported for one node stays bounded regardless of how many nested schema errors
 *    its body produces, which is the protection the fail-fast body check exists for.
 * A change that satisfies one by giving up the other passes only one of the tests below.
 */

import { describe, test, expect } from "@jest/globals";
import { GraphValidator } from "@mcp-moira/workflow-engine";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

function workflowWith(nodes: unknown[]): WorkflowGraph {
  return {
    metadata: { name: "Diagnostics", version: "1.0.0", description: "test" },
    nodes: nodes as WorkflowGraph["nodes"],
  };
}

describe("Node diagnostics: missing required fields", () => {
  test("all missing top-level required fields of a node are named", async () => {
    const validator = new GraphValidator();

    const result = await validator.validateUnified(
      workflowWith([
        { type: "start", id: "start", connections: { default: "sub" } },
        // graphId, inputMapping and outputMapping are all absent.
        { type: "subgraph", id: "sub", connections: { success: "end" } },
        { type: "end", id: "end" },
      ]),
    );

    const messages = result.issues.map((issue) => issue.message).join(" ");
    expect(messages).toContain("graphId");
    expect(messages).toContain("inputMapping");
    expect(messages).toContain("outputMapping");
  });

  test("a present-but-invalid field is still reported through the body check", async () => {
    const validator = new GraphValidator();

    const result = await validator.validateUnified(
      workflowWith([
        { type: "start", id: "start", connections: { default: "t" } },
        // `message` is present, so it is not a missing-field case: only the body check sees it.
        { type: "telegram-notification", id: "t", message: "", connections: { default: "end" } },
        { type: "end", id: "end" },
      ]),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.severity === "error")).toBe(true);
  });
});

describe("Node diagnostics: reported volume stays bounded", () => {
  test("a body producing many nested schema errors yields a bounded report", async () => {
    // 100 file entries, each violating the entry schema in several ways at once. The input stays
    // far inside the validator's own input-size limits, so validation really reaches the schema
    // check — a workflow rejected by those limits would report a single limit message and would
    // prove nothing about this property.
    const files = Array.from({ length: 100 }, (_, index) => ({
      unexpectedProperty: index,
      from: 1,
      content: "not-empty",
    }));

    const validator = new GraphValidator();
    const result = await validator.validateUnified(
      workflowWith([
        { type: "start", id: "start", connections: { default: "m" } },
        {
          type: "materialize",
          id: "m",
          basePath: "./out",
          files,
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ]),
    );

    expect(result.valid).toBe(false);

    const limitMessage = result.issues.find((issue) =>
      /exceeds validation depth or entry limits/i.test(issue.message),
    );
    // The observation is only meaningful when the input was actually validated against the schema.
    expect(limitMessage).toBeUndefined();

    const nodeIssues = result.issues.filter((issue) => issue.nodeId === "m");
    expect(nodeIssues.length).toBeGreaterThan(0);

    // Distinct reported statements for this node, counted the way an author reads them.
    const reportedStatements = nodeIssues
      .flatMap((issue) => issue.message.split(";"))
      .map((part) => part.trim())
      .filter(Boolean);

    // 100 entries × several violations each would be hundreds of statements without the bound.
    expect(reportedStatements.length).toBeLessThan(20);
  });
});
