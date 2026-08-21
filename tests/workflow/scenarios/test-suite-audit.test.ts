/**
 * Contract and behavioral scenarios for moira/test-suite-audit.
 *
 * The flow builds complete feature-first evidence before recommendations, requires exact authority
 * before mutation, verifies each logical mutation class, and keeps every delivery outcome distinct.
 */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  GraphExecutionEngine,
  GraphTemplateProcessor,
  GraphValidator,
  MaterializeHandler,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import { runScenario, type MockInput, type TestScenario } from "../../helpers/scenario-runner.js";

const catalogEntry = findSystemCatalogEntry("test-suite-audit", "public")!;

function loadWorkflow(): WorkflowGraph {
  return structuredClone(catalogEntry.graph) as WorkflowGraph;
}

function node(workflow: WorkflowGraph, id: string): any {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function useMaterializeGrant(engine: GraphExecutionEngine): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, MaterializeHandler> })
    .nodeHandlers;
  handlers.set(
    "materialize",
    new MaterializeHandler(
      { createMaterializeToken: () => "test-suite-audit-token" },
      () => "https://moira.example",
    ),
  );
}

function cleanInputs(
  options: {
    batches?: number;
    decision?: "analysis_only" | "apply" | "abort";
    changeClasses?: number;
    delivery?: "local" | "publish" | "publish_notify";
  } = {},
): Record<string, MockInput> {
  const batches = options.batches ?? 1;
  const decision = options.decision ?? "analysis_only";
  const changeClasses = options.changeClasses ?? 1;
  const delivery = options.delivery ?? "local";
  return {
    "resolve-scope": {},
    "materialize-workspace": {},
    "discover-corpus": { batch_total: batches, batch_cursor: 0 },
    "review-taxonomy": { issues_count: 0 },
    "confirm-scope-taxonomy": { decision: "accept" },
    "map-batch": {},
    "review-mapping": { issues_count: 0 },
    "analyze-suite": {},
    "review-analysis": { issues_count: 0 },
    "present-recommendations": { decision },
    "establish-baseline": {
      baseline_state: "ready",
      change_class_total: changeClasses,
      change_class_cursor: 0,
    },
    "apply-change-class": {},
    "targeted-check-class": { check_state: "pass" },
    "review-changes": { issues_count: 0 },
    "broad-verification": { verification_state: "pass" },
    "write-final-report": {},
    "review-final-report": { issues_count: 0 },
    "delivery-decision": { delivery },
    "upload-report": {
      upload_state: "uploaded",
      report_url: "https://audit.static.moira-mcp.com/",
    },
    "notify-user": { notification_state: "sent" },
  };
}

function run(workflow: WorkflowGraph, value: TestScenario) {
  return runScenario(workflow, value, { engineSetup: useMaterializeGrant });
}

describe("test-suite-audit", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("preserves public identity and validates the accepted 93-node 4.0.0 graph", async () => {
    expect(catalogEntry.owner).toBe("system-moira");
    expect(catalogEntry.slug).toBe("test-suite-audit");
    expect(catalogEntry.visibility).toBe("public");
    expect(workflow.id).toBe("41246c35-cada-43ae-917c-57b1ea90c1bd");
    expect(workflow.metadata.version).toBe("4.0.0");
    expect(workflow.nodes).toHaveLength(93);
    const validation = await new GraphValidator().validateUnified(workflow);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  test("publishes a detailed selection contract instead of stale project counts", () => {
    const description = workflow.metadata.description;
    for (const phrase of [
      "Feature-first audit",
      "complete in-scope source and test corpus",
      "independently reviewed batches",
      "analysis only",
      "exact reviewed mutation set",
      "pre-change baseline",
      "one logical mutation class at a time",
      "scoped revert",
      "limited non-mutating report",
      "optional authorized static publication",
      "preserves unrelated dirty work",
      "Test Planning",
      "Test Generation",
      "Data Analysis",
      "Software Development Flow",
    ])
      expect(description).toContain(phrase);
    expect(description).not.toContain("3,122");
    expect(description).not.toContain("Jest");
  });

  test("materializes one registry standard into an execution-bound workspace", async () => {
    expect(Object.keys(workflow.variableRegistry!).sort()).toEqual([
      "audit_standard",
      "batch_cursor",
      "batch_total",
      "change_class_cursor",
      "change_class_total",
      "notification_state",
      "outcome",
      "report_path",
      "report_url",
      "workspace_path",
    ]);
    expect(workflow.variableRegistry!.workspace_path).toMatchObject({
      const: "./moira-ws/test-suite-audit-{{executionId}}",
      default: "./moira-ws/test-suite-audit-{{executionId}}",
    });
    expect(workflow.variableRegistry!.report_path).toMatchObject({
      const: "final-report.md",
      default: "final-report.md",
    });
    expect(String(workflow.variableRegistry!.audit_standard.default)).toContain(
      "## Mutation, verification and recovery",
    );
    expect(node(workflow, "materialize-workspace")).toMatchObject({
      basePath: "./moira-ws/test-suite-audit-{{executionId}}",
      files: expect.arrayContaining([{ path: "audit-standard.md", from: "audit_standard" }]),
    });
    expect(node(workflow, "discover-corpus").directive).toContain("never rewrite it");
    const executionId = "00000000-0000-4000-8000-000000000123";
    const rendered = await new GraphTemplateProcessor().processDirectiveAsync(
      node(workflow, "discover-corpus").directive,
      {
        variables: Object.fromEntries(
          Object.entries(workflow.variableRegistry!).map(([key, definition]) => [
            key,
            definition.default,
          ]),
        ),
        nodeStates: {},
        executionId,
        workflowId: workflow.id,
        userId: "workflow-test-user",
        _templateFragmentVars: GraphTemplateProcessor.computeFragmentVars(
          workflow.variableRegistry,
        ),
      },
    );
    expect(rendered).toContain(`./moira-ws/test-suite-audit-${executionId}/audit-standard.md`);
    expect(rendered).not.toContain("{{executionId}}");
  });

  test("uses strict authority schemas and routes correction from the user target", () => {
    const correction = node(workflow, "confirm-scope-taxonomy").inputSchema;
    expect(correction.additionalProperties).toBe(false);
    expect(correction.properties.decision.enum).toEqual(["accept", "correct"]);
    expect(correction.allOf[0].then.required).toEqual(["correction_target", "feedback"]);
    expect(node(workflow, "apply-user-correction").inputSchema.properties).toEqual({});
    expect(node(workflow, "user-correction-scope").condition.left.contextPath).toBe(
      "confirm-scope-taxonomy.correction_target",
    );
    expect(node(workflow, "present-recommendations").inputSchema.properties.decision.enum).toEqual([
      "analysis_only",
      "apply",
      "revise",
      "abort",
    ]);
    expect(node(workflow, "failure-decision").inputSchema.properties.decision.enum).toEqual([
      "repair",
      "revert",
    ]);
  });

  test("keeps report, abort, and recovery-blocked terminals distinct", () => {
    expect(node(workflow, "end-report").finalOutput).toEqual([
      "outcome",
      "report_path",
      "report_url",
      "notification_state",
    ]);
    expect(node(workflow, "end-abort").finalOutput).toEqual(["outcome"]);
    expect(node(workflow, "end-blocked").finalOutput).toEqual(["outcome"]);
    expect(node(workflow, "repair-final-report").inputSchema.properties.repair_reach.enum).toEqual([
      "report",
      "analysis",
      "work_applied",
      "work_reverted",
    ]);
  });

  test("rejects correction without feedback before its owner", async () => {
    const result = await run(workflow, {
      name: "missing correction feedback",
      mockInputs: {
        ...cleanInputs({ batches: 0 }),
        "confirm-scope-taxonomy": { decision: "correct", correction_target: "scope" },
      },
      expect: { status: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'confirm-scope-taxonomy'");
    expect(result.visitedNodes).not.toContain("apply-user-correction");
  });

  test("rejects an invented URL on upload failure", async () => {
    const result = await run(workflow, {
      name: "invented upload URL",
      mockInputs: {
        ...cleanInputs({ batches: 0, delivery: "publish" }),
        "upload-report": { upload_state: "failed", report_url: "https://invented.example/report" },
      },
      expect: { status: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'upload-report'");
  });

  test("scope and taxonomy corrections take observably different routes", async () => {
    const scope = await run(workflow, {
      name: "scope correction regenerates",
      mockInputs: {
        ...cleanInputs({ batches: 0 }),
        "discover-corpus": [
          { batch_total: 2, batch_cursor: 0 },
          { batch_total: 0, batch_cursor: 0 },
        ],
        "review-taxonomy": [{ issues_count: 0 }, { issues_count: 0 }],
        "confirm-scope-taxonomy": [
          { decision: "correct", correction_target: "scope", feedback: "Exclude generated tests." },
          { decision: "accept" },
        ],
        "apply-user-correction": { batch_cursor: 0 },
      },
      expect: { status: "completed" },
    });
    expect(scope.passed).toBe(true);
    expect(scope.inputSubmissionCounts["discover-corpus"]).toBe(2);

    const taxonomy = await run(workflow, {
      name: "taxonomy correction re-reviews",
      mockInputs: {
        ...cleanInputs({ batches: 0 }),
        "review-taxonomy": [{ issues_count: 0 }, { issues_count: 0 }],
        "confirm-scope-taxonomy": [
          {
            decision: "correct",
            correction_target: "taxonomy",
            feedback: "Split billing behavior.",
          },
          { decision: "accept" },
        ],
        "apply-user-correction": { batch_cursor: 0 },
      },
      expect: { status: "completed" },
    });
    expect(taxonomy.passed).toBe(true);
    expect(taxonomy.inputSubmissionCounts["discover-corpus"]).toBe(1);
    expect(taxonomy.inputSubmissionCounts["review-taxonomy"]).toBe(2);
  });

  test("combined discriminating scenarios cover every executable node and branch", async () => {
    const scenarios: TestScenario[] = [
      {
        name: "analysis zero local",
        mockInputs: cleanInputs({ batches: 0 }),
        expect: { status: "completed" },
      },
      {
        name: "user scope correction regenerates derived evidence",
        mockInputs: {
          ...cleanInputs({ batches: 0 }),
          "discover-corpus": [
            { batch_total: 1, batch_cursor: 0 },
            { batch_total: 0, batch_cursor: 0 },
          ],
          "review-taxonomy": [{ issues_count: 0 }, { issues_count: 0 }],
          "confirm-scope-taxonomy": [
            {
              decision: "correct",
              correction_target: "scope",
              feedback: "Exclude generated fixtures from the authorized corpus.",
            },
            { decision: "accept" },
          ],
          "apply-user-correction": { batch_cursor: 0 },
        },
        expect: { status: "completed" },
      },
      {
        name: "apply batches classes publish notify",
        mockInputs: cleanInputs({
          batches: 2,
          decision: "apply",
          changeClasses: 2,
          delivery: "publish_notify",
        }),
        expect: { status: "completed" },
      },
      {
        name: "taxonomy repair no changes",
        mockInputs: {
          ...cleanInputs({ batches: 0, decision: "apply", changeClasses: 0 }),
          "review-taxonomy": [{ issues_count: 2 }, { issues_count: 0 }],
          "repair-taxonomy": { repair_reach: "taxonomy", batch_total: 0, batch_cursor: 0 },
        },
        expect: { status: "completed" },
      },
      {
        name: "taxonomy repair discovers stale scope",
        mockInputs: {
          ...cleanInputs({ batches: 0 }),
          "discover-corpus": [
            { batch_total: 0, batch_cursor: 0 },
            { batch_total: 0, batch_cursor: 0 },
          ],
          "review-taxonomy": [{ issues_count: 1 }, { issues_count: 0 }],
          "repair-taxonomy": { repair_reach: "scope", batch_total: 0, batch_cursor: 0 },
        },
        expect: { status: "completed" },
      },
      {
        name: "user taxonomy correction re-enters taxonomy review",
        mockInputs: {
          ...cleanInputs({ batches: 0 }),
          "review-taxonomy": [{ issues_count: 0 }, { issues_count: 0 }],
          "confirm-scope-taxonomy": [
            {
              decision: "correct",
              correction_target: "taxonomy",
              feedback: "Separate authentication behavior from generic infrastructure.",
            },
            { decision: "accept" },
          ],
          "apply-user-correction": { batch_cursor: 0 },
        },
        expect: { status: "completed" },
      },
      {
        name: "irreducible taxonomy limited upload failure",
        mockInputs: {
          ...cleanInputs({ batches: 0, delivery: "publish" }),
          "review-taxonomy": { issues_count: 1 },
          "repair-taxonomy": { repair_reach: "irreducible", batch_total: 0, batch_cursor: 0 },
          "irreducible-decision": { decision: "limited_report" },
          "upload-report": { upload_state: "failed", report_url: "" },
        },
        expect: { status: "completed" },
      },
      {
        name: "irreducible mapping abort",
        mockInputs: {
          ...cleanInputs(),
          "review-mapping": { issues_count: 1 },
          "repair-mapping": { repair_reach: "irreducible" },
          "irreducible-decision": { decision: "abort" },
        },
        expect: { status: "completed" },
      },
      {
        name: "mapping contained",
        mockInputs: {
          ...cleanInputs(),
          "review-mapping": [{ issues_count: 1 }, { issues_count: 0 }],
          "repair-mapping": { repair_reach: "mapping" },
        },
        expect: { status: "completed" },
      },
      {
        name: "mapping taxonomy",
        mockInputs: {
          ...cleanInputs(),
          "review-taxonomy": [{ issues_count: 0 }, { issues_count: 0 }],
          "confirm-scope-taxonomy": [{ decision: "accept" }, { decision: "accept" }],
          "map-batch": [{}, {}],
          "review-mapping": [{ issues_count: 1 }, { issues_count: 0 }],
          "repair-mapping": { repair_reach: "taxonomy" },
        },
        expect: { status: "completed" },
      },
      {
        name: "mapping scope",
        mockInputs: {
          ...cleanInputs(),
          "discover-corpus": [
            { batch_total: 1, batch_cursor: 0 },
            { batch_total: 0, batch_cursor: 0 },
          ],
          "review-taxonomy": [{ issues_count: 0 }, { issues_count: 0 }],
          "confirm-scope-taxonomy": [{ decision: "accept" }, { decision: "accept" }],
          "review-mapping": { issues_count: 1 },
          "repair-mapping": { repair_reach: "scope" },
        },
        expect: { status: "completed" },
      },
      {
        name: "analysis repair reaches and revise",
        mockInputs: {
          ...cleanInputs({ batches: 0 }),
          "review-taxonomy": [{ issues_count: 0 }, { issues_count: 0 }, { issues_count: 0 }],
          "confirm-scope-taxonomy": [
            { decision: "accept" },
            { decision: "accept" },
            { decision: "accept" },
          ],
          "discover-corpus": [
            { batch_total: 0, batch_cursor: 0 },
            { batch_total: 0, batch_cursor: 0 },
          ],
          "analyze-suite": [{}, {}, {}, {}],
          "review-analysis": [
            { issues_count: 1 },
            { issues_count: 1 },
            { issues_count: 1 },
            { issues_count: 0 },
            { issues_count: 0 },
          ],
          "repair-analysis": [
            { repair_reach: "analysis" },
            { repair_reach: "taxonomy" },
            { repair_reach: "scope" },
          ],
          "present-recommendations": [
            { decision: "revise", feedback: "Narrow the recommendation." },
            { decision: "analysis_only" },
          ],
          "revise-recommendations": { repair_reach: "analysis" },
        },
        expect: { status: "completed", maxSteps: 180 },
      },
      {
        name: "recommendation taxonomy revision abort",
        mockInputs: {
          ...cleanInputs({ batches: 0 }),
          "review-taxonomy": [{ issues_count: 0 }, { issues_count: 0 }],
          "confirm-scope-taxonomy": [{ decision: "accept" }, { decision: "accept" }],
          "review-analysis": [{ issues_count: 0 }, { issues_count: 0 }],
          "present-recommendations": [
            { decision: "revise", feedback: "Correct taxonomy." },
            { decision: "abort" },
          ],
          "revise-recommendations": { repair_reach: "taxonomy" },
        },
        expect: { status: "completed" },
      },
      {
        name: "recommendation scope revision regenerates corpus",
        mockInputs: {
          ...cleanInputs({ batches: 0 }),
          "discover-corpus": [
            { batch_total: 0, batch_cursor: 0 },
            { batch_total: 0, batch_cursor: 0 },
          ],
          "review-taxonomy": [{ issues_count: 0 }, { issues_count: 0 }],
          "confirm-scope-taxonomy": [{ decision: "accept" }, { decision: "accept" }],
          "review-analysis": [{ issues_count: 0 }, { issues_count: 0 }],
          "present-recommendations": [
            { decision: "revise", feedback: "Remove generated fixtures from scope." },
            { decision: "analysis_only" },
          ],
          "revise-recommendations": { repair_reach: "scope" },
        },
        expect: { status: "completed" },
      },
      ...(["limited_report", "abort"] as const).map((decision) => ({
        name: `baseline ${decision}`,
        mockInputs: {
          ...cleanInputs({ batches: 0, decision: "apply" }),
          "establish-baseline": {
            baseline_state: "limited",
            change_class_total: 0,
            change_class_cursor: 0,
          },
          "baseline-limited-decision": { decision },
        },
        expect: { status: "completed" as const },
      })),
      {
        name: "class failure repair",
        mockInputs: {
          ...cleanInputs({ batches: 0, decision: "apply" }),
          "targeted-check-class": [{ check_state: "fail" }, { check_state: "pass" }],
          "class-failure-decision": { decision: "repair" },
          "repair-class-failure": {},
        },
        expect: { status: "completed" },
      },
      {
        name: "class failure revert",
        mockInputs: {
          ...cleanInputs({ batches: 0, decision: "apply" }),
          "targeted-check-class": { check_state: "fail" },
          "class-failure-decision": { decision: "revert" },
          "revert-changes": { restoration_state: "restored" },
        },
        expect: { status: "completed" },
      },
      {
        name: "changed review contained",
        mockInputs: {
          ...cleanInputs({ batches: 0, decision: "apply" }),
          "review-changes": [{ issues_count: 1 }, { issues_count: 0 }],
          "repair-changes": { repair_reach: "contained" },
        },
        expect: { status: "completed" },
      },
      {
        name: "changed review scope changing",
        mockInputs: {
          ...cleanInputs({ batches: 0, decision: "apply" }),
          "review-changes": { issues_count: 1 },
          "repair-changes": { repair_reach: "scope_changing" },
          "review-analysis": [{ issues_count: 0 }, { issues_count: 0 }],
          "present-recommendations": [{ decision: "apply" }, { decision: "analysis_only" }],
        },
        expect: { status: "completed" },
      },
      {
        name: "broad repair",
        mockInputs: {
          ...cleanInputs({ batches: 0, decision: "apply" }),
          "broad-verification": [{ verification_state: "fail" }, { verification_state: "pass" }],
          "failure-decision": { decision: "repair" },
          "repair-failure": {},
        },
        expect: { status: "completed" },
      },
      {
        name: "broad revert blocked",
        mockInputs: {
          ...cleanInputs({ batches: 0, decision: "apply" }),
          "broad-verification": { verification_state: "fail" },
          "failure-decision": { decision: "revert" },
          "revert-changes": { restoration_state: "blocked" },
        },
        expect: { status: "completed" },
      },
      {
        name: "final report repair publish",
        mockInputs: {
          ...cleanInputs({ batches: 0, delivery: "publish" }),
          "review-final-report": [{ issues_count: 1 }, { issues_count: 0 }],
          "repair-final-report": { repair_reach: "report" },
        },
        expect: { status: "completed" },
      },
      {
        name: "final analysis repair",
        mockInputs: {
          ...cleanInputs({ batches: 0 }),
          "review-analysis": [{ issues_count: 0 }, { issues_count: 0 }],
          "present-recommendations": [{ decision: "analysis_only" }, { decision: "analysis_only" }],
          "review-final-report": [{ issues_count: 1 }, { issues_count: 0 }],
          "repair-final-report": { repair_reach: "analysis" },
        },
        expect: { status: "completed" },
      },
      {
        name: "final applied work repair",
        mockInputs: {
          ...cleanInputs({ batches: 0, decision: "apply" }),
          "review-final-report": [{ issues_count: 1 }, { issues_count: 0 }],
          "repair-final-report": { repair_reach: "work_applied" },
          "repair-final-applied-work": {},
        },
        expect: { status: "completed" },
      },
      {
        name: "final reverted work repair notify failure",
        mockInputs: {
          ...cleanInputs({ batches: 0, decision: "apply", delivery: "publish_notify" }),
          "broad-verification": { verification_state: "fail" },
          "failure-decision": { decision: "revert" },
          "revert-changes": { restoration_state: "restored" },
          "review-final-report": [{ issues_count: 1 }, { issues_count: 0 }],
          "repair-final-report": { repair_reach: "work_reverted" },
          "repair-final-reverted-work": { restoration_state: "restored" },
          "notify-user": { notification_state: "failed" },
        },
        expect: { status: "completed" },
      },
      {
        name: "final reverted repair remains restoration blocked",
        mockInputs: {
          ...cleanInputs({ batches: 0, decision: "apply" }),
          "broad-verification": { verification_state: "fail" },
          "failure-decision": { decision: "revert" },
          "revert-changes": { restoration_state: "restored" },
          "review-final-report": { issues_count: 1 },
          "repair-final-report": { repair_reach: "work_reverted" },
          "repair-final-reverted-work": { restoration_state: "blocked" },
        },
        expect: { status: "completed" },
      },
      {
        name: "impossible nonmutating work blocks",
        mockInputs: {
          ...cleanInputs({ batches: 0 }),
          "review-final-report": { issues_count: 1 },
          "repair-final-report": { repair_reach: "work_applied" },
        },
        expect: { status: "completed" },
      },
      {
        name: "impossible nonmutating revert repair blocks",
        mockInputs: {
          ...cleanInputs({ batches: 0 }),
          "review-final-report": { issues_count: 1 },
          "repair-final-report": { repair_reach: "work_reverted" },
        },
        expect: { status: "completed" },
      },
    ];

    const results = [];
    for (const value of scenarios) results.push(await run(workflow, value));
    const failed = results.filter((result) => !result.passed);
    if (failed.length)
      console.error(
        failed.map((result) => ({
          scenario: result.scenario,
          error: result.error,
          expectations: result.failedExpectations,
          last: result.visitedNodes.slice(-12),
        })),
      );
    expect(failed).toEqual([]);
    const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });
    if (coverage.nodeCoverage !== 100 || coverage.branchCoverage !== 100)
      console.error({
        nodeCoverage: coverage.nodeCoverage,
        branchCoverage: coverage.branchCoverage,
        unvisitedNodes: coverage.unvisitedNodes,
        uncoveredBranches: coverage.uncoveredBranches,
      });
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
  });
});
