import { describe, expect, test } from "@jest/globals";
import { performance } from "node:perf_hooks";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { renderWorkflowSchema } from "../../../packages/workflow-cli/src/workflow-schema.js";

function graph(nodes: WorkflowGraph["nodes"]): WorkflowGraph {
  return {
    metadata: { name: "Schema fixture", version: "1.0.0", description: "" },
    variableRegistry: {
      mode: { type: "string", description: "Mode", enum: ["yes", "no"] },
      payload: {
        type: "string",
        description: "Payload",
        default: "Materialized {{registry_only}}",
      },
      registry_only: { type: "string", description: "Registry-only reference", default: "ok" },
    },
    nodes,
  };
}

function definitions(output: string, kind: "NODE" | "EDGE"): string[] {
  const prefix = kind === "NODE" ? "  NODE " : "    EDGE ";
  return output.split("\n").filter((line) => line.startsWith(prefix));
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

describe("workflow schema renderer", () => {
  test("should collapse a maximal linear chain into one readable basic block", () => {
    const workflow = graph([
      { id: "start", type: "start", connections: { default: "work" } },
      {
        id: "work",
        type: "agent-directive",
        directive: "Do work",
        completionCondition: "Done",
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ]);

    const output = renderWorkflowSchema(workflow);

    expect(output).toContain("BLOCK B001 start -> work -> end");
    expect(output).toContain("COVERAGE nodes=3/3 edges=2/2");
  });

  test("renders the complete static progress topology and many-to-one primary mappings", () => {
    const workflow = graph([
      { id: "start", type: "start", connections: { default: "work" } },
      {
        id: "work",
        type: "agent-directive",
        progressNodeId: "implementation",
        progressActiveLabel: "Implement {{unit}}/{{total}}",
        directive: "Work",
        completionCondition: "Done",
        connections: { success: "review-one" },
      },
      {
        id: "review-one",
        type: "agent-directive",
        progressNodeId: "review",
        directive: "Review",
        completionCondition: "Done",
        connections: { success: "review-two" },
      },
      {
        id: "review-two",
        type: "agent-directive",
        progressNodeId: "review",
        directive: "Review again",
        completionCondition: "Done",
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ]);
    workflow.progress = {
      title: "Development {{mode}}",
      nodes: [
        {
          id: "implementation",
          label: "Implementation",
          connections: { default: "review" },
        },
        { id: "review", label: "Review", connections: { default: "implementation" } },
      ],
    };

    const output = renderWorkflowSchema(workflow);

    expect(output).toContain("progress_nodes=2 progress_edges=2 progress_mappings=3");
    expect(output).toContain('TITLE "Development {{mode}}"');
    expect(output).toContain('PROGRESS_NODE implementation label="Implementation" primary=work');
    expect(output).toContain('PROGRESS_NODE review label="Review" primary=review-one, review-two');
    expect(output).toContain("EDGE [default] -> implementation");
    expect(output).toContain("PROGRESS_NODE review");
    expect(output).toContain('PROGRESS_ACTIVE_LABEL "Implement {{unit}}/{{total}}"');
    expect(output).toContain("COVERAGE nodes=2/2 edges=2/2 mappings=3/3");
  });

  test("should render a deep graph without recursive traversal overflow", () => {
    const depth = 5_000;
    const nodes: WorkflowGraph["nodes"] = [
      { id: "start", type: "start", connections: { default: "step-0" } },
    ];
    for (let index = 0; index < depth; index++) {
      nodes.push({
        id: `step-${index}`,
        type: "expression",
        expressions: [`value = ${index}`],
        connections: { default: index === depth - 1 ? "end" : `step-${index + 1}` },
      });
    }
    nodes.push({ id: "end", type: "end" });

    const output = renderWorkflowSchema(graph(nodes));

    expect(output).toContain(
      `COVERAGE nodes=${depth + 2}/${depth + 2} edges=${depth + 1}/${depth + 1}`,
    );
    expect(output).toContain(`NODE step-${depth - 1} [expression]`);
  });

  test("should classify many independent cycles with complete indexed output", () => {
    const cycleCount = 10_000;
    const nodes: WorkflowGraph["nodes"] = [
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end" },
    ];
    for (let index = 0; index < cycleCount; index++) {
      nodes.push({
        id: `cycle-${index}`,
        type: "expression",
        expressions: ["value = 1"],
        connections: { default: `cycle-${index}` },
      });
    }

    const startedAt = performance.now();
    const output = renderWorkflowSchema(graph(nodes));
    const elapsedMs = performance.now() - startedAt;

    expect(output.match(/^ {2}CYCLE /gm)).toHaveLength(cycleCount);
    expect(output).toContain("CYCLE cycle-0");
    expect(output).toContain(`CYCLE cycle-${cycleCount - 1}`);
    expect(output).toContain(
      `COVERAGE nodes=${cycleCount + 2}/${cycleCount + 2} edges=${cycleCount + 1}/${cycleCount + 1}`,
    );
    expect(elapsedMs).toBeLessThan(2_000);
  });

  test("should render branch, merge, cycle, schemas and context references losslessly", () => {
    const workflow = graph([
      { id: "start", type: "start", connections: { default: "decide" } },
      {
        id: "decide",
        type: "condition",
        condition: { operator: "eq", left: { contextPath: "mode" }, right: "yes" },
        connections: { true: "work", false: "merge" },
      },
      {
        id: "work",
        type: "agent-directive",
        directive: "Use {{mode}} without interpreting it",
        completionCondition: "Done",
        inputSchema: {
          type: "object",
          properties: { outcome: { type: "string", enum: ["ok", "retry"] } },
          globalInputs: ["mode"],
          required: ["outcome", "mode"],
        },
        connections: { success: "merge" },
      },
      {
        id: "merge",
        type: "expression",
        expressions: ["attempt = attempt + 1"],
        connections: { default: "loop" },
      },
      {
        id: "loop",
        type: "condition",
        condition: { operator: "lt", left: { contextPath: "attempt" }, right: 2 },
        connections: { true: "merge", false: "end" },
      },
      { id: "end", type: "end" },
      {
        id: "resume",
        type: "teleport",
        directive: "Resume",
        completionCondition: "Ready",
        hint: "External entry",
        connections: { success: "merge" },
      },
    ]);
    const before = JSON.stringify(workflow);

    const first = renderWorkflowSchema(workflow);
    const second = renderWorkflowSchema(workflow);

    expect(first).toBe(second);
    expect(JSON.stringify(workflow)).toBe(before);
    expect(first).toContain("START_ENTRIES start");
    expect(first).toContain("TELEPORT_ENTRIES resume");
    expect(first).toContain("TELEPORT_ONLY resume");
    expect(first).toContain(
      'CONDITION {"left":{"contextPath":"mode"},"operator":"eq","right":"yes"}',
    );
    expect(first).toContain(
      'OUTPUT local outcome required {"enum":["ok","retry"],"type":"string"}',
    );
    expect(first).toContain(
      'OUTPUT global mode required {"description":"Mode","enum":["yes","no"],"type":"string"}',
    );
    expect(first).toContain("CONTEXT {{mode}}");
    expect(first).toContain("CONTEXT attempt");
    expect(first).toContain('EXPRESSION "attempt = attempt + 1"');
    expect(first).toContain("CYCLE merge");
    expect(definitions(first, "NODE")).toHaveLength(workflow.nodes.length);
    expect(definitions(first, "EDGE")).toHaveLength(8);
    expect(new Set(definitions(first, "NODE")).size).toBe(workflow.nodes.length);
    expect(new Set(definitions(first, "EDGE")).size).toBe(8);
    expect(first).toContain("COVERAGE nodes=7/7 edges=8/8");
  });

  test("should distinguish teleports, acyclic orphan roots and disconnected cycles", () => {
    const workflow = graph([
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end" },
      {
        id: "resume",
        type: "teleport",
        directive: "Resume",
        completionCondition: "Ready",
        hint: "External entry",
        connections: { success: "teleport-end" },
      },
      { id: "teleport-end", type: "end" },
      {
        id: "orphan-root",
        type: "expression",
        expressions: ["x = 1"],
        connections: { default: "orphan-leaf" },
      },
      { id: "orphan-leaf", type: "end" },
      {
        id: "orphan-a",
        type: "condition",
        condition: { operator: "exists", value: { contextPath: "missing" } },
        connections: { true: "orphan-b", false: "missing-target" },
      },
      {
        id: "orphan-b",
        type: "expression",
        expressions: ["x = 1"],
        connections: { default: "orphan-a" },
      },
    ]);

    const output = renderWorkflowSchema(workflow);

    expect(output).toContain("START_ENTRIES start");
    expect(output).toContain("TELEPORT_ENTRIES resume");
    expect(output).toContain("DISCONNECTED_ROOTS orphan-root");
    expect(output).toContain("TELEPORT_ONLY resume, teleport-end");
    expect(output).toContain("DISCONNECTED orphan-root, orphan-leaf, orphan-a, orphan-b");
    expect(output).toContain("DANGLING E004");
    expect(output).toContain("EDGE E004 [false] -> missing-target [DANGLING]");
    expect(output).toContain("CYCLE orphan-a");
    expect(output).toContain("COVERAGE nodes=8/8 edges=6/6");
  });

  test("should render every current node data-flow declaration", () => {
    const workflow = graph([
      {
        id: "start",
        type: "start",
        initialData: { variables: { seed: { description: "Seed", value: 1 } } },
        connections: { default: "child" },
      },
      {
        id: "child",
        type: "subgraph",
        graphId: "owner/child",
        inputMapping: { parent_b: "child_b", parent_a: "child_a" },
        outputMapping: { child_result: "parent_result" },
        connections: { success: "read" },
      },
      {
        id: "read",
        type: "read-note",
        outputVariable: "notes",
        connections: { default: "upsert" },
      },
      {
        id: "upsert",
        type: "upsert-note",
        keyTemplate: "result",
        value: "{{notes}}",
        outputVariable: "write_result",
        connections: { default: "write" },
      },
      {
        id: "write",
        type: "write-note",
        source: "items",
        batchMode: true,
        connections: { default: "materialize" },
      },
      {
        id: "materialize",
        type: "materialize",
        basePath: "./output",
        files: [{ path: "result.txt", from: "payload" }],
        connections: { success: "work" },
      },
      {
        id: "work",
        type: "agent-directive",
        directive: "Finish",
        completionCondition: "Finished",
        inputSchema: {
          type: "object",
          properties: { result: { type: "string" } },
          globalInputs: ["mode"],
          required: ["result"],
        },
        connections: { success: "end" },
      },
      { id: "end", type: "end", finalOutput: ["result", "mode"] },
    ]);

    const output = renderWorkflowSchema(workflow);

    expect(output).toContain(
      'INITIAL_DATA {"variables":{"seed":{"description":"Seed","value":1}}}',
    );
    expect(output).toContain('SUBGRAPH "owner/child"');
    expect(output).toContain('INPUT_MAPPING {"parent_a":"child_a","parent_b":"child_b"}');
    expect(output).toContain('OUTPUT_MAPPING {"child_result":"parent_result"}');
    expect(output).toContain('OUTPUT context "notes"');
    expect(output).toContain('OUTPUT context "write_result"');
    expect(output).toContain('INPUT context "items"');
    expect(output).toContain(
      'INPUT registry payload {"default":"Materialized {{registry_only}}","description":"Payload","type":"string"}',
    );
    expect(output).toContain('OUTPUT local result required {"type":"string"}');
    expect(output).toContain(
      'OUTPUT global mode optional {"description":"Mode","enum":["yes","no"],"type":"string"}',
    );
    expect(output).toContain('OUTPUT final ["result","mode"]');
    expect(output).toContain("CONTEXT {{notes}}");
    expect(output).toContain("CONTEXT {{registry_only}}");
  });

  test("should canonicalize connection and mapping object key order", () => {
    const left = graph([
      { id: "start", type: "start", connections: { default: "route" } },
      {
        id: "route",
        type: "condition",
        condition: { operator: "exists", value: { contextPath: "mode" } },
        connections: { true: "child", false: "end" },
      },
      {
        id: "child",
        type: "subgraph",
        graphId: "owner/child",
        inputMapping: { second: "b", first: "a" },
        outputMapping: { result_b: "parent_b", result_a: "parent_a" },
        connections: { success: "end", error: "end" },
      },
      { id: "end", type: "end" },
    ]);
    const right = graph([
      { id: "start", type: "start", connections: { default: "route" } },
      {
        id: "route",
        type: "condition",
        condition: { value: { contextPath: "mode" }, operator: "exists" },
        connections: { false: "end", true: "child" },
      },
      {
        id: "child",
        type: "subgraph",
        graphId: "owner/child",
        inputMapping: { first: "a", second: "b" },
        outputMapping: { result_a: "parent_a", result_b: "parent_b" },
        connections: { error: "end", success: "end" },
      },
      { id: "end", type: "end" },
    ]);

    expect(renderWorkflowSchema(left)).toBe(renderWorkflowSchema(right));
  });

  test("should use locale-independent code-unit ordering for canonical labels", () => {
    const output = renderWorkflowSchema({
      metadata: { name: "Unicode labels", version: "1.0.0", description: "" },
      nodes: [
        {
          id: "start",
          type: "start",
          connections: { ä: "end", z: "end" },
        } as unknown as WorkflowGraph["nodes"][number],
        { id: "end", type: "end" },
      ],
    });

    expect(output.indexOf("EDGE E001 [z]")).toBeLessThan(output.indexOf('EDGE E002 ["ä"]'));
  });

  test("should reject duplicate node ids instead of producing an ambiguous schema", () => {
    const workflow = graph([
      { id: "same", type: "end" },
      { id: "same", type: "end" },
    ]);

    expect(() => renderWorkflowSchema(workflow)).toThrow(
      "Duplicate node IDs prevent an unambiguous schema: same",
    );
  });

  test("should render workflow-authored structural tokens without terminal control bytes", () => {
    const output = renderWorkflowSchema({
      metadata: { name: "Name\u001b]0;title\u0007\u009b", version: "1.0.0" },
      nodes: [
        {
          id: "start\u001b[31mINJECT",
          type: "start",
          connections: { "go\u001b]0;INJECT\u0007": "end" },
        },
        { id: "end", type: "end" },
      ],
    });

    expect(output).toContain('START_ENTRIES "start\\u001b[31mINJECT"');
    expect(output).toContain('["go\\u001b]0;INJECT\\u0007"] -> end');
    expect(hasTerminalControl(output)).toBe(false);
  });
});
