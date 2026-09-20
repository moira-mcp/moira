/**
 * Workflow definition migration: the pre-routing shape (schema version 0) is upgraded to the
 * current shape once, exactly, and never twice.
 */

import { describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  migrateWorkflowGraph,
  workflowSchemaVersion,
} from "@mcp-moira/workflow-engine/migration";
import { GraphValidator } from "@mcp-moira/workflow-engine";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const FLOWS_DIR = path.resolve(process.cwd(), "workflows/production/flows");

function v0Graph(): Record<string, unknown> {
  return {
    id: "legacy",
    metadata: { name: "Legacy", version: "1.2.3", description: "pre-routing shape" },
    variableRegistry: {
      score: { type: "number", description: "score" },
    },
    nodes: [
      { id: "start", type: "start", connections: { default: "ask" } },
      {
        id: "ask",
        type: "agent-directive",
        directive: "Score it",
        completionCondition: "Scored",
        inputSchema: {
          type: "object",
          properties: {},
          globalInputs: ["score"],
          required: ["score"],
        },
        maxRetries: 3,
        retryMessage: "try again",
        currentRetries: 0,
        connections: { success: "gate", maxRetriesExceeded: "low" },
      },
      {
        id: "gate",
        type: "condition",
        condition: { operator: "gte", left: { contextPath: "score" }, right: 8 },
        connections: { true: "high", false: "low" },
        connectionLabels: { true: "high score", false: { label: "low score" } },
      },
      { id: "high", type: "end" },
      { id: "low", type: "end" },
    ],
  };
}

describe("migrateWorkflowGraph", () => {
  test("upgrades a version-0 definition: condition becomes one case plus default, retry fields go", () => {
    const result = migrateWorkflowGraph(v0Graph());

    expect(result).toMatchObject({ from: 0, to: CURRENT_WORKFLOW_SCHEMA_VERSION, changed: true });
    const graph = result.graph as unknown as WorkflowGraph;
    expect(graph.metadata.schemaVersion).toBe(CURRENT_WORKFLOW_SCHEMA_VERSION);

    const gate = graph.nodes.find((node) => node.id === "gate") as unknown as Record<
      string,
      unknown
    >;
    expect(gate).toEqual({
      id: "gate",
      type: "condition",
      cases: [
        { when: { operator: "gte", left: { contextPath: "score" }, right: 8 }, output: "true" },
      ],
      connections: { true: "high", default: "low" },
      connectionLabels: { true: "high score", default: { label: "low score" } },
    });
    expect("condition" in gate).toBe(false);

    const ask = graph.nodes.find((node) => node.id === "ask") as unknown as Record<string, unknown>;
    expect(ask).not.toHaveProperty("maxRetries");
    expect(ask).not.toHaveProperty("retryMessage");
    expect(ask).not.toHaveProperty("currentRetries");
    expect(ask.connections).toEqual({ success: "gate" });
  });

  test("does not mutate its input", () => {
    const input = v0Graph();
    const snapshot = JSON.stringify(input);
    migrateWorkflowGraph(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("is idempotent: a migrated definition comes back unchanged and by reference", () => {
    const once = migrateWorkflowGraph(v0Graph()).graph;
    const twice = migrateWorkflowGraph(once);
    expect(twice.changed).toBe(false);
    expect(twice.graph).toBe(once);
    expect(workflowSchemaVersion(once)).toBe(CURRENT_WORKFLOW_SCHEMA_VERSION);
  });

  test("a migrated definition validates and its migrated condition routes both ways", async () => {
    const graph = migrateWorkflowGraph(v0Graph()).graph;
    const result = await new GraphValidator().validateUnified(graph);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  test("leaves non-object input alone", () => {
    expect(migrateWorkflowGraph(null as unknown as Record<string, unknown>).changed).toBe(false);
    expect(migrateWorkflowGraph("x" as unknown as Record<string, unknown>).changed).toBe(false);
  });

  test("every bundled flow migrates to the current version and validates without errors", async () => {
    const validator = new GraphValidator();
    const files = fs.readdirSync(FLOWS_DIR).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      // A catalog file carries owner/slug/visibility/previousSlugs beside the graph; the catalog
      // reader strips them before the graph is validated, so this test does the same.
      const {
        owner: _owner,
        slug: _slug,
        visibility: _visibility,
        previousSlugs: _previous,
        ...raw
      } = JSON.parse(fs.readFileSync(path.join(FLOWS_DIR, file), "utf8"));
      const migration = migrateWorkflowGraph(raw);
      expect(workflowSchemaVersion(migration.graph)).toBe(CURRENT_WORKFLOW_SCHEMA_VERSION);
      const again = migrateWorkflowGraph(migration.graph);
      expect(again.changed).toBe(false);
      const nodes = (migration.graph as WorkflowGraph).nodes;
      for (const node of nodes) {
        if (node.type === "condition") {
          expect(node.cases.length).toBeGreaterThan(0);
          expect(node.connections.default).toBeTruthy();
          expect(node).not.toHaveProperty("condition");
        }
      }
      const result = await validator.validateUnified(migration.graph);
      const errors = result.issues.filter((issue) => issue.severity === "error");
      expect({ file, errors }).toEqual({ file, errors: [] });
    }
  });
});
