/**
 * Full Catalog Validation Tests (Step 14)
 *
 * Guarantees that EVERY flow in the production catalog (workflows/production/flows/) validates with
 * zero errors under the explicit output-scope rules — the full-set guarantee of the globalInputs
 * migration. This is the regression guard: any flow that drifts out of the model fails here.
 */

import { describe, test, expect } from "@jest/globals";
import { GraphValidator } from "@mcp-moira/workflow-engine";
import { readWorkflowCatalog } from "@mcp-moira/shared";

describe("Production catalog validation", () => {
  const validator = new GraphValidator();
  const entries = readWorkflowCatalog();

  test("catalog is non-empty", () => {
    // The public OSS repo bundles the public catalog only (private flows live in the separate
    // private folder merged at build time via WORKFLOWS_DIRS).
    expect(entries.length).toBeGreaterThanOrEqual(30);
  });

  test("every catalog flow validates with zero errors under the output-scope rules", async () => {
    const failures: Array<{ ref: string; errors: string[] }> = [];

    for (const entry of entries) {
      const result = await validator.validateUnified({
        id: `moira/${entry.slug}`,
        ...entry.graph,
      });
      if (!result.valid) {
        failures.push({
          ref: `${entry.owner}/${entry.slug}`,
          errors: result.issues
            .filter((i) => i.severity === "error")
            .map((i) => `[${i.type}] ${i.nodeId ?? ""} ${i.message}`),
        });
      }
    }

    if (failures.length > 0) {
      console.error("Invalid catalog flows:");
      for (const f of failures) {
        console.error(`  ${f.ref}:\n    ${f.errors.join("\n    ")}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("every declared globalInputs name exists in its flow's variableRegistry", () => {
    const violations: string[] = [];
    for (const entry of entries) {
      const registry = (entry.graph.variableRegistry ?? {}) as Record<string, unknown>;
      const nodes = (entry.graph.nodes ?? []) as Array<{
        id: string;
        inputSchema?: { globalInputs?: unknown };
      }>;
      for (const node of nodes) {
        const gi = node.inputSchema?.globalInputs;
        if (!Array.isArray(gi)) continue;
        for (const name of gi) {
          if (typeof name === "string" && !(name in registry)) {
            violations.push(
              `${entry.owner}/${entry.slug}: node ${node.id} globalInput '${name}' not in registry`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("no node declares the same name as both a global write and a local output", () => {
    const violations: string[] = [];
    for (const entry of entries) {
      const nodes = (entry.graph.nodes ?? []) as Array<{
        id: string;
        inputSchema?: { globalInputs?: unknown; properties?: Record<string, unknown> };
      }>;
      for (const node of nodes) {
        const gi = node.inputSchema?.globalInputs;
        const props = node.inputSchema?.properties;
        if (!Array.isArray(gi) || !props) continue;
        for (const name of gi) {
          if (typeof name === "string" && name in props) {
            violations.push(
              `${entry.owner}/${entry.slug}: node ${node.id} '${name}' is both global and local`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  // A workspace_path reference is a directory; building a child path by writing
  // {{workspace_path}}file.md (or {{node.workspace_path}}file.md) drops the
  // directory separator and yields ...1645step-1 instead of ...1645/step-1.
  // The template validator cannot catch this (it is valid template text), so it
  // is guarded here across the whole catalog.
  test("no string field joins a workspace_path reference to a path segment without a slash", () => {
    const defect = /\{\{[a-zA-Z0-9_.-]*workspace_path\}\}[a-zA-Z]/g;
    // Recursively scan EVERY string in the graph — the defect appears not only in
    // directive/completionCondition/message, but also in inputSchema property
    // descriptions and variableRegistry descriptions, all of which reach the agent.
    const scan = (value: unknown, path: string, out: string[]): void => {
      if (typeof value === "string") {
        const matches = value.match(defect);
        if (matches) out.push(`${path} — ${matches.join(", ")}`);
      } else if (Array.isArray(value)) {
        value.forEach((v, i) => scan(v, `${path}[${i}]`, out));
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) scan(v, `${path}.${k}`, out);
      }
    };
    const violations: string[] = [];
    for (const entry of entries) {
      scan(entry.graph.nodes, `${entry.owner}/${entry.slug}:nodes`, violations);
      scan(
        entry.graph.variableRegistry,
        `${entry.owner}/${entry.slug}:variableRegistry`,
        violations,
      );
    }
    expect(violations).toEqual([]);
  });

  // The #565 counter-pinning defect: a GLOBAL numeric variable the flow grows at runtime (an
  // expression counter, or an agent write across nodes) whose registry schema declares a value space
  // it never truly has. validateUnified cannot catch this — enum:[0], minimum:1, maximum:7 are all
  // well-formed — so the guarantee is machine-checked here.
  //   - GLOBAL numeric (variableRegistry): NO enum/minimum/maximum. Globals are mutated across the
  //     flow; a bound restored from a single reset-node output mis-describes the running value. The
  //     remigration strips these for numeric/expression-target globals; this guard locks it in.
  //   - NODE-LOCAL numeric output (inputSchema.properties): no enum (numeric enums are reset
  //     artifacts), but minimum/maximum are LEGITIMATE — a one-shot agent output like
  //     issues_count(min 0) or score(0..10) is validated once per node execution, not mutated.
  test("no numeric global (or numeric enum) carries a value-bounding keyword (counter-pinning guard)", () => {
    const violations: string[] = [];
    const isNumeric = (t: unknown): boolean => t === "number" || t === "integer";
    const globalBounding = ["enum", "minimum", "maximum"];
    for (const entry of entries) {
      const registry = (entry.graph.variableRegistry ?? {}) as Record<
        string,
        { type?: unknown } & Record<string, unknown>
      >;
      for (const [name, schema] of Object.entries(registry)) {
        if (schema && isNumeric(schema.type)) {
          const bad = globalBounding.filter((k) => k in schema);
          if (bad.length) {
            violations.push(
              `${entry.owner}/${entry.slug}: global registry '${name}' is numeric with [${bad.join(",")}]`,
            );
          }
        }
      }
      // Node-local numeric properties may carry min/max (legitimate one-shot output bounds) but never
      // an enum (a numeric enum is always a reset artifact).
      const nodes = (entry.graph.nodes ?? []) as Array<{
        id: string;
        inputSchema?: { properties?: Record<string, { type?: unknown } & Record<string, unknown>> };
      }>;
      for (const node of nodes) {
        const props = node.inputSchema?.properties;
        if (!props) continue;
        for (const [name, schema] of Object.entries(props)) {
          if (schema && isNumeric(schema.type) && "enum" in schema) {
            violations.push(
              `${entry.owner}/${entry.slug}: node ${node.id} property '${name}' is numeric with enum`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
