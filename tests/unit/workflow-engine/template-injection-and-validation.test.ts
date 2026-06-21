/**
 * §10/§14 — template-injection protection + validator hardening.
 *
 * Fix C / injection: a value substituted from DATA must never be re-interpreted as a
 *   template (no {{context.variables}} dump, no {{#each}}/{{#if}} execution); an
 *   author-controlled fragment var (run_tests_directive) must still expand.
 * Fix B: a directive rendered with an unresolved variable emits a logger.warn.
 * Fix A: a registry variable declared without a default and never written emits a
 *   severity:"warning" validation issue (not an error); declaring a default OR writing
 *   it (globalInputs / expression) suppresses the warning.
 */

import { describe, test, expect, jest } from "@jest/globals";
import { GraphTemplateProcessor } from "../../../packages/workflow-engine/src/templates/graph-template-processor.js";
import { GraphValidator } from "../../../packages/workflow-engine/src/validation/graph-validator.js";

const ctx = (variables: Record<string, unknown>) => ({
  variables,
  nodeStates: {},
  executionId: "test-exec",
  workflowId: "test-wf",
  userId: "test-user",
});

describe("§14 template-injection protection", () => {
  test("injected {{context.variables}} in a data value renders literally, does NOT dump the bag", () => {
    const processor = new GraphTemplateProcessor();
    const out = processor.processDirective(
      "Note: {{payload}}",
      ctx({ secret: "TOPSECRET", payload: "leak={{context.variables}}" }),
    );
    expect(out).toContain("{{context.variables}}"); // literal, not expanded
    expect(out).not.toContain("TOPSECRET"); // bag never dumped
  });

  test("injected {{#each}} in a data value renders literally, loop NOT executed", () => {
    const processor = new GraphTemplateProcessor();
    const out = processor.processDirective(
      "{{payload}}",
      ctx({ items: ["X", "Y"], payload: "{{#each items}}{{this}}{{/each}}" }),
    );
    expect(out).toBe("{{#each items}}{{this}}{{/each}}"); // verbatim
    expect(out).not.toBe("XY"); // not executed
  });

  test("injected node-path {{n.field}} in a data value renders literally", () => {
    const processor = new GraphTemplateProcessor();
    const out = processor.processDirective(
      "{{payload}}",
      ctx({ payload: "{{some-node.secretField}}" }),
    );
    expect(out).toBe("{{some-node.secretField}}");
  });

  test("REGRESSION: author-controlled fragment var (run_tests_directive) still expands", () => {
    const processor = new GraphTemplateProcessor();
    const out = processor.processDirective(
      "{{run_tests_directive}}",
      ctx({ run_tests_directive: "{{#if test_command}}RUN{{/if}}", test_command: "yes" }),
    );
    expect(out).toBe("RUN");
  });
});

describe("§10 Fix B — runtime placeholder guard", () => {
  test("unresolved variable keeps the placeholder in output AND logs a warn", () => {
    const processor = new GraphTemplateProcessor();
    const warn = jest.fn();
    // replace the instance logger with a stub that captures warn
    (processor as unknown as { logger: Record<string, unknown> }).logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn,
      error: jest.fn(),
    };
    const out = processor.processDirective("Hi {{missing}}", ctx({}));
    expect(out).toContain("[[UNDEFINED_VARIABLE]]");
    expect(warn).toHaveBeenCalled();
  });

  test("fully-resolved directive does not warn", () => {
    const processor = new GraphTemplateProcessor();
    const warn = jest.fn();
    (processor as unknown as { logger: Record<string, unknown> }).logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn,
      error: jest.fn(),
    };
    processor.processDirective("Hi {{name}}", ctx({ name: "Bob" }));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("§10 Fix A — declared-but-never-defined registry variable warning", () => {
  const wf = (registry: Record<string, unknown>, extraNodes: unknown[] = []) => ({
    id: "wf-fixA",
    metadata: { name: "fixA", version: "1.0.0", description: "d" },
    nodes: [
      { id: "start", type: "start", connections: { default: "a" } },
      {
        id: "a",
        type: "agent-directive",
        directive: "Use {{ghost}} here",
        completionCondition: "done",
        inputSchema: { type: "object", properties: {} },
        connections: { success: "end" },
      },
      ...extraNodes,
      { id: "end", type: "end" },
    ],
    variableRegistry: registry,
  });

  test("registry var with NO default and no writer -> a warning (validation still valid)", async () => {
    const v = new GraphValidator();
    const res = await v.validateUnified(wf({ ghost: { type: "string", description: "g" } }));
    const warns = res.issues.filter(
      (i) => i.severity === "warning" && i.nodeId === "a" && /ghost/.test(i.message),
    );
    expect(warns.length).toBe(1);
    expect(res.valid).toBe(true); // warning does not fail validation
    expect(res.issues.some((i) => i.severity === "error")).toBe(false);
  });

  test("registry var WITH a default -> no never-defined warning", async () => {
    const v = new GraphValidator();
    const res = await v.validateUnified(
      wf({ ghost: { type: "string", default: "", description: "g" } }),
    );
    expect(
      res.issues.some(
        (i) => i.severity === "warning" && /never written|without a default/.test(i.message),
      ),
    ).toBe(false);
  });

  test("registry var written by an expression node -> no false-positive warning", async () => {
    const v = new GraphValidator();
    const exprNode = {
      id: "seed",
      type: "expression",
      expressions: ['ghost = "x"'],
      connections: { default: "a" },
    };
    // re-point start to the expression node so the graph stays connected
    const graph = wf({ ghost: { type: "string", description: "g" } }, [exprNode]);
    graph.nodes[0] = { id: "start", type: "start", connections: { default: "seed" } } as never;
    const res = await v.validateUnified(graph);
    expect(res.issues.some((i) => i.severity === "warning" && /ghost/.test(i.message))).toBe(false);
  });
});

describe("§14 fragment-var detection (provenance ∪ name convention)", () => {
  test("computeFragmentVars collects only registry vars whose default carries a template", () => {
    const set = GraphTemplateProcessor.computeFragmentVars({
      email_body: { default: "Hi {{name}}" }, // template default → fragment
      steps: { default: [] as unknown as string }, // non-string default → not
      counter: { default: 0 as unknown as string }, // numeric → not
      notes: { default: "plain text" }, // no template → not
      missing: {}, // no default → not
    });
    expect(set.has("email_body")).toBe(true);
    expect(set.has("steps")).toBe(false);
    expect(set.has("counter")).toBe(false);
    expect(set.has("notes")).toBe(false);
    expect(set.has("missing")).toBe(false);
  });

  test("PROVENANCE: an oddly-named var whose template is supplied via _templateFragmentVars expands its nested template", () => {
    const processor = new GraphTemplateProcessor();
    const context = ctx({ email_body: "Hi {{name}}", name: "Bob" });
    (context as unknown as { _templateFragmentVars: Set<string> })._templateFragmentVars = new Set([
      "email_body",
    ]);
    expect(processor.processDirective("{{email_body}}", context)).toBe("Hi Bob");
  });

  test("without the fragment set, the same oddly-named var is neutralized (nested template stays literal)", () => {
    const processor = new GraphTemplateProcessor();
    const out = processor.processDirective(
      "{{email_body}}",
      ctx({ email_body: "Hi {{name}}", name: "Bob" }),
    );
    expect(out).toBe("Hi {{name}}"); // neutralized, not expanded
    expect(out).not.toBe("Hi Bob");
  });

  test("NAME CONVENTION: a *_instruction var (empty default) is treated as a fragment, so its runtime template expands (sdf case)", () => {
    const processor = new GraphTemplateProcessor();
    // No _templateFragmentVars provided; the *_instruction name convention must catch it,
    // so the value is spliced verbatim (not neutralized) and its conditional expands.
    const out = processor.processDirective(
      "{{validate_test_instruction}}",
      ctx({ validate_test_instruction: "{{#if mode}}RUN{{/if}}", mode: "go" }),
    );
    expect(out).toBe("RUN");
  });

  test("generic agent-output var (evidence) is NOT a fragment — injected template stays literal", () => {
    const processor = new GraphTemplateProcessor();
    const context = ctx({ evidence: "{{context.variables}}", secret: "TOP" });
    (context as unknown as { _templateFragmentVars: Set<string> })._templateFragmentVars =
      GraphTemplateProcessor.computeFragmentVars({ evidence: { default: "" } }); // empty set
    const out = processor.processDirective("Note: {{evidence}}", context);
    expect(out).toContain("{{context.variables}}");
    expect(out).not.toContain("TOP");
  });
});
