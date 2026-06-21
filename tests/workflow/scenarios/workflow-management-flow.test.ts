/**
 * Test Scenarios for workflow-management-flow v3.10.0
 *
 * Tests the meta-workflow for creating and editing workflows:
 * - Create mode: new workflow from scratch, with patterns, validation loops
 * - Edit mode: online with local file, download from server, version conflicts
 * - Validation loops: fix cycles for plans and workflows
 * - Error handling: upload errors, review issues
 *
 * IMPORTANT: Uses actual production workflow from workflows/production/public/workflow-management-flow.json
 */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import { runScenario, TestScenario, ScenarioResult } from "../../helpers/scenario-runner.js";
import { GraphValidator, detectCycles } from "@mcp-moira/workflow-engine";
import { calculateCoverage, formatCoverageReport } from "../../helpers/coverage-calculator.js";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

/**
 * Load actual production workflow
 */
function loadProductionWorkflow(): WorkflowGraph {
  return findSystemCatalogEntry("workflow-management-flow", "public")!.graph as WorkflowGraph;
}

describe("workflow-management-flow Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "workflow-management-flow"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected validation loops (cycles are intentional)", () => {
      const cycles = detectCycles(workflow);
      // workflow-management-flow has intentional validation loops:
      // - Pattern revision loop
      // - Stages refinement loop
      // - Structure refinement loop
      // - Validation error fix loop
      // - Edit plan revision loop
      // - Review issues fix loop
      // - Upload retry loop
      expect(cycles.length).toBeGreaterThan(0);

      // Verify known validation loops exist
      const cycleNodeIds = cycles.flat();
      expect(cycleNodeIds).toContain("validate-workflow");
      expect(cycleNodeIds).toContain("fix-validation-errors");
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(93);
    });

    it("should contain anti-pattern catalog in the variable registry", () => {
      const registry = (workflow as any).variableRegistry;
      expect(registry).toBeDefined();

      // Anti-pattern catalog with all 16 patterns
      expect(registry.anti_pattern_catalog).toBeDefined();
      const catalog = String(registry.anti_pattern_catalog.default);
      for (let i = 1; i <= 16; i++) {
        expect(catalog).toContain(`ANTI-PATTERN #${i}`);
      }
      // #7 corrected: must mention "dynamic data" scope, not just size threshold
      expect(catalog).toContain("DYNAMIC data");
      // #12 new: externalizing critical instructions
      expect(catalog).toContain("Externalizing Critical Instructions");
      // #13-#16: false-loop, declared-but-no-default, template-in-data, injection
      expect(catalog).toContain("False-Loop");
      expect(catalog).toContain("Template Injection");
    });

    it("should contain canonical workflow example reference", () => {
      const registry = (workflow as any).variableRegistry;
      expect(registry.canonical_workflow_example).toBeDefined();
      expect(String(registry.canonical_workflow_example.default)).toContain(
        "moira/software-development-flow",
      );
    });

    it("should contain correct patterns including static configuration", () => {
      const registry = (workflow as any).variableRegistry;
      expect(registry.correct_patterns).toBeDefined();
      const patterns = String(registry.correct_patterns.default);
      expect(patterns).toContain("Dynamic Array Index Pattern");
      expect(patterns).toContain("Static Workflow Configuration Pattern");
      // Static config is taught via a registry default, not the removed start-node initialData
      expect(patterns).toContain("registry default");
      expect(patterns).toContain("variableRegistry globals");
    });

    it("should teach the explicit output-scope variable model (not the removed initialData model)", () => {
      const registry = (workflow as any).variableRegistry;
      // The variable-model guide teaches registry globals + node-local outputs + explicit globalInputs
      const guide = String(registry.initialdata_structure_guide?.default ?? "");
      expect(guide).toContain("variableRegistry");
      expect(guide).toContain("globalInputs");
      expect(guide).toContain("node-id");
      // It teaches the ABSENCE of the old model, and must not instruct putting variables in initialData
      expect(guide).toContain("NO start-node initialData.variables");
      // The template guide resolves bare globals + node-id.name locals, no initialData source
      const tmpl = String(registry.template_usage_guide?.default ?? "");
      expect(tmpl).toContain("variableRegistry");
      expect(tmpl).toContain("There is no initialData");
    });

    it("should reference anti-patterns in validation nodes with corrected checks", () => {
      const qualityNode = workflow.nodes.find((n) => n.id === "review-workflow-quality");
      expect(qualityNode).toBeDefined();
      expect((qualityNode as any).directive).toContain("ANTI-PATTERN COMPLIANCE");
      // Must check for 16 patterns
      expect((qualityNode as any).directive).toContain("check all 16 patterns");
      // Must reference correct_patterns
      expect((qualityNode as any).directive).toContain("correct_patterns");
      // #7 correction: must mention static config exception (registry-default model)
      expect((qualityNode as any).directive).toContain(
        "static config declared as a variableRegistry default is CORRECT",
      );
      // Variable-model checks: the quality review must enforce the explicit-scope model
      expect((qualityNode as any).directive).toContain("variableRegistry");
      expect((qualityNode as any).directive).toContain("globalInputs");
      expect((qualityNode as any).directive).toContain("node-id.name");

      const validateNode = workflow.nodes.find((n) => n.id === "validate-workflow");
      expect(validateNode).toBeDefined();
      expect((validateNode as any).directive).toContain("anti_pattern_catalog");
    });
  });

  describe("Authoring per WMF guidance produces a valid workflow", () => {
    // A flow authored exactly as the rewritten WMF guidance instructs:
    // - a global declared once in variableRegistry
    // - a node that writes that global by listing it in inputSchema.globalInputs
    // - a node-local output described in inputSchema.properties
    // - a later directive referencing the global by bare name
    const authored: WorkflowGraph = {
      id: "moira/authored-per-guidance",
      slug: "authored-per-guidance",
      metadata: { name: "Authored Per Guidance", version: "1.0.0", description: "x" },
      variableRegistry: {
        analysis_done: { type: "boolean", description: "Whether analysis completed" },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "analyze" } },
        {
          type: "agent-directive",
          id: "analyze",
          directive: "Analyze the input and report findings.",
          completionCondition: "Findings produced",
          inputSchema: {
            type: "object",
            globalInputs: ["analysis_done"],
            properties: { summary: { type: "string", description: "Short summary" } },
            required: ["analysis_done", "summary"],
          },
          connections: { success: "report" },
        },
        {
          type: "agent-directive",
          id: "report",
          // references the global by bare name AND the local as node-id.name
          directive: "Analysis done = {{analysis_done}}. Summary: {{analyze.summary}}.",
          completionCondition: "Report written",
          inputSchema: { type: "object", properties: {}, required: [] },
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    } as unknown as WorkflowGraph;

    it("validates a flow authored per the guidance with zero errors", async () => {
      const validator = new GraphValidator();
      const result = await validator.validateUnified(authored);
      expect(result.valid).toBe(true);
      expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });

    it("rejects a globalInputs name not declared in the registry", async () => {
      const broken = JSON.parse(JSON.stringify(authored)) as WorkflowGraph;
      const analyze = broken.nodes.find((n) => n.id === "analyze") as any;
      analyze.inputSchema.globalInputs = ["not_in_registry"];
      analyze.inputSchema.required = ["not_in_registry", "summary"];
      const validator = new GraphValidator();
      const result = await validator.validateUnified(broken);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.severity === "error")).toBe(true);
    });

    it("rejects a bare-name reference that is not a declared global", async () => {
      const broken = JSON.parse(JSON.stringify(authored)) as WorkflowGraph;
      const report = broken.nodes.find((n) => n.id === "report") as any;
      report.directive = "Value is {{undeclared_global}}.";
      const validator = new GraphValidator();
      const result = await validator.validateUnified(broken);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.severity === "error")).toBe(true);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        // === CREATE BRANCH SCENARIOS ===

        // Scenario 1: Create happy path - direct approval of patterns, stages, structure
        {
          name: "Create happy path",
          description: "Create workflow with all approvals on first try",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "test-flow",
              workflow_purpose: "Test workflow for testing",
              visibility: "private",
              use_pattern_validation_loop: true,
              use_pattern_info_collection: true,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "No specific domain practices needed for this simple test workflow scenario",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["Stage 1", "Stage 2"],
              stages_approved: "yes",
            },
            "review-stages-completeness": {
              stages_review_issues_count: 0,
            },
            "design-workflow-structure": {
              workflow_graph: "start → stage1-node → stage2-node → end",
              node_count: 4,
            },
            "approve-structure": {
              structure_approved: "yes",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 4,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": {
              implementation_review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 2: Create with pattern revision
        {
          name: "Create with pattern revision",
          description: "User revises proposed patterns before approval",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "revised-flow",
              workflow_purpose: "Workflow with revised patterns",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Domain practices found including validation patterns and review standards for workflows",
              needs_domain_knowledge: true,
              domain_knowledge_types: ["quality_standards", "validation_criteria"],
            },
            "analyze-and-propose": {
              patterns_confirmed: "no",
            },
            "revise-patterns": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["S1", "S2", "S3"],
              stages_approved: "yes",
            },
            "review-stages-completeness": {
              stages_review_issues_count: 0,
            },
            "design-workflow-structure": {
              workflow_graph: "start → step1 → step2 → step3 → end",
              node_count: 5,
            },
            "approve-structure": {
              structure_approved: "yes",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 5,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": {
              implementation_review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 3: Create with stages refinement
        {
          name: "Create with stages refinement",
          description: "User refines stages before approval",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "refined-stages",
              workflow_purpose: "Workflow with refined stages",
              visibility: "public",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["A", "B"],
              stages_approved: "no",
            },
            "refine-stages": {
              main_stages: ["A", "B", "C"],
              stages_approved: "yes",
            },
            "review-stages-completeness": {
              stages_review_issues_count: 0,
            },
            "design-workflow-structure": {
              workflow_graph: "start → step-a → step-b → step-c → end",
              node_count: 5,
            },
            "approve-structure": {
              structure_approved: "yes",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 5,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": {
              implementation_review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 4: Create with stages review failure
        {
          name: "Create with stages review failure",
          description: "Stages review fails, fix and retry",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "stages-fix",
              workflow_purpose: "Test stages fix loop",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["Stage1", "Stage2"],
              stages_approved: "yes",
            },
            // First review fails, second passes
            "review-stages-completeness": [
              { stages_review_issues_count: 1, stages_review_issues: ["Missing stage"] },
              { stages_review_issues_count: 0 },
            ],
            "fix-stages-issues": {
              main_stages: ["Stage1", "Stage2", "Stage3"],
              fixes_applied: "Added missing stage",
            },
            "design-workflow-structure": {
              workflow_graph: "start → stage1 → stage2 → review → end",
              node_count: 5,
            },
            "approve-structure": {
              structure_approved: "yes",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": {
              implementation_review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 5: Create with structure refinement
        {
          name: "Create with structure refinement",
          description: "User refines workflow structure",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "refined-structure",
              workflow_purpose: "Workflow with refined structure",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["X", "Y"],
              stages_approved: "yes",
            },
            "review-stages-completeness": {
              stages_review_issues_count: 0,
            },
            "design-workflow-structure": {
              workflow_graph: "start → step-one → step-two → end",
              node_count: 4,
            },
            // First rejects, second approves
            "approve-structure": [
              { structure_approved: "no", structure_feedback: "Need Y stage" },
              { structure_approved: "yes" },
            ],
            "refine-structure": {
              workflow_graph: "start → gather-info → step-one → step-two → review → end",
              node_count: 6,
              changes_made: "Added gather-info and review steps for better flow",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 4,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": {
              implementation_review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 6: Create with implementation review failure
        {
          name: "Create with implementation review failure",
          description: "Implementation review fails, fix and retry",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "impl-fix",
              workflow_purpose: "Test implementation fix loop",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["Stage1", "Stage2"],
              stages_approved: "yes",
            },
            "review-stages-completeness": {
              stages_review_issues_count: 0,
            },
            "design-workflow-structure": {
              workflow_graph: "start → stage1 → stage2 → review → end",
              node_count: 5,
            },
            "approve-structure": {
              structure_approved: "yes",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            // First review fails, second passes
            "review-implementation-completeness": [
              {
                implementation_review_issues_count: 1,
                implementation_review_issues: ["Missing connection"],
              },
              { implementation_review_issues_count: 0 },
            ],
            "fix-implementation-issues": {
              fixes_applied: "yes",
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 7: Create with validation failure and fix
        {
          name: "Create with validation failure",
          description: "Workflow fails validation, gets fixed",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "validation-fix",
              workflow_purpose: "Test validation loop",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["Stage1", "Stage2"],
              stages_approved: "yes",
            },
            "review-stages-completeness": {
              stages_review_issues_count: 0,
            },
            "design-workflow-structure": {
              workflow_graph: "start → stage1 → stage2 → review → end",
              node_count: 5,
            },
            "approve-structure": {
              structure_approved: "yes",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": {
              implementation_review_issues_count: 0,
            },
            // First fails, second passes
            "validate-workflow": [
              { validation_passed: "no", validation_errors: ["Missing connection"] },
              { validation_passed: "yes" },
            ],
            "fix-validation-errors": {
              errors_fixed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 8: Create with quality review failure
        {
          name: "Create with quality review failure",
          description: "Quality review fails, fix and retry",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "quality-fix",
              workflow_purpose: "Test quality fix loop",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["Stage1", "Stage2"],
              stages_approved: "yes",
            },
            "review-stages-completeness": {
              stages_review_issues_count: 0,
            },
            "design-workflow-structure": {
              workflow_graph: "start → stage1 → stage2 → review → end",
              node_count: 5,
            },
            "approve-structure": {
              structure_approved: "yes",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": {
              implementation_review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            // First fails, second passes
            "review-workflow-quality": [
              { quality_review_issues_count: 1, quality_review_issues: ["Poor directive"] },
              { quality_review_issues_count: 0 },
            ],
            "fix-quality-issues": {
              fixes_applied: "yes",
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 9: Create with final review rejection
        {
          name: "Create with final review rejection",
          description: "User rejects at final review, re-enters edit mode",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "review-reject",
              workflow_purpose: "Test final review rejection",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["S1", "S2"],
              stages_approved: "yes",
            },
            "review-stages-completeness": {
              stages_review_issues_count: 0,
            },
            "design-workflow-structure": {
              workflow_graph: "start → step-one → step-two → end",
              node_count: 4,
            },
            "approve-structure": {
              structure_approved: "yes",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": {
              implementation_review_issues_count: 0,
            },
            "validate-workflow": [{ validation_passed: "yes" }, { validation_passed: "yes" }],
            "review-workflow-quality": [
              { quality_review_issues_count: 0 },
              { quality_review_issues_count: 0 },
            ],
            // First rejects, second approves
            "user-final-review": [
              { work_approved: "no", final_feedback: "Need changes" },
              { work_approved: "yes" },
            ],
            // After rejection → gather-edit-requirements
            "gather-edit-requirements": {
              nodes_to_add: ["Add new node"],
            },
            "create-edit-plan": {
              plan_created: "yes",
              planned_changes_count: 3,
              edit_plan:
                "## Target Workflow\n- ID: review-reject\n\n## Planned Changes\n1. Add new validation node\n2. Update connections\n3. Fix directive",
            },
            "validate-edit-plan": {
              validation_issues_count: 0,
            },
            "present-edit-plan": {
              plan_approval: "yes",
            },
            "apply-workflow-changes": {
              changes_applied: "yes",
              new_node_count: 5,
            },
            "review-changes-before-upload": {
              review_issues_count: 0,
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 10: Create skip upload
        {
          name: "Create skip upload",
          description: "User chooses to skip upload",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "skip-upload",
              workflow_purpose: "Test workflow for skip upload functionality",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["S1", "S2"],
              stages_approved: "yes",
            },
            "review-stages-completeness": {
              stages_review_issues_count: 0,
            },
            "design-workflow-structure": {
              workflow_graph: "start → step-one → step-two → end",
              node_count: 4,
            },
            "approve-structure": {
              structure_approved: "yes",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": {
              implementation_review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: false,
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // === EDIT BRANCH SCENARIOS ===

        // Scenario 11: Edit online - local file exists, no version conflict
        {
          name: "Edit online with local file",
          description: "Edit workflow online, local file exists",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "edit",
              has_file_access: true,
              has_web_access: true,
            },
            "select-workflow-to-edit-online": {
              workflow_id_to_edit: "test-workflow",
            },
            "search-local-workflow-file": {
              local_workflow_path: "workflows/test-workflow.json",
            },
            "setup-workspace": {
              workspace_path: "./moira-ws/test-workflow-edit-20250115-1200/",
            },
            "load-workflow-for-edit": {
              workflow_loaded: "yes",
              current_node_count: 10,
              version_conflict: "no",
            },
            "gather-edit-requirements": {
              nodes_to_update: ["Update node"],
            },
            "create-edit-plan": {
              edit_plan: "Edit plan: add node-a, remove node-b",
              plan_created: "yes",
              planned_changes_count: 3,
            },
            "validate-edit-plan": {
              validation_issues_count: 0,
            },
            "present-edit-plan": {
              plan_approval: "yes",
            },
            "apply-workflow-changes": {
              changes_applied: "yes",
              new_node_count: 5,
            },
            "review-changes-before-upload": {
              review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 12: Edit - no local file, download from server
        {
          name: "Edit download from server",
          description: "No local file, download workflow from server",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "edit",
              has_file_access: true,
              has_web_access: true,
            },
            "select-workflow-to-edit-online": {
              workflow_id_to_edit: "server-only-workflow",
            },
            "search-local-workflow-file": {
              local_workflow_path: "",
            },
            "download-workflow-from-server": {
              local_workflow_path: "workflows/downloaded/server-only-workflow.json",
            },
            "setup-workspace": {
              workspace_path: "./moira-ws/server-only-edit-20250115-1201/",
            },
            "load-workflow-for-edit": {
              workflow_loaded: "yes",
              current_node_count: 8,
              version_conflict: "no",
            },
            "gather-edit-requirements": {
              nodes_to_remove: ["Remove old node"],
            },
            "create-edit-plan": {
              edit_plan: "Edit plan: add node-a, remove node-b",
              plan_created: "yes",
              planned_changes_count: 3,
            },
            "validate-edit-plan": {
              validation_issues_count: 0,
            },
            "present-edit-plan": {
              plan_approval: "yes",
            },
            "apply-workflow-changes": {
              changes_applied: "yes",
              new_node_count: 5,
            },
            "review-changes-before-upload": {
              review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 13: Edit with version conflict
        {
          name: "Edit with version conflict",
          description: "Local and server versions differ",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "edit",
              has_file_access: true,
              has_web_access: true,
            },
            "select-workflow-to-edit-online": {
              workflow_id_to_edit: "conflict-workflow",
            },
            "search-local-workflow-file": {
              local_workflow_path: "workflows/conflict-workflow.json",
            },
            "setup-workspace": {
              workspace_path: "./moira-ws/conflict-edit-20250115-1202/",
            },
            "load-workflow-for-edit": {
              workflow_loaded: "yes",
              current_node_count: 6,
              version_conflict: "yes",
              local_version: "1.0.0",
              server_version: "1.1.0",
            },
            "resolve-version-conflict": {
              resolution: "server",
            },
            "gather-edit-requirements": {
              nodes_to_update: ["Fix node"],
            },
            "create-edit-plan": {
              edit_plan: "Edit plan: add node-a, remove node-b",
              plan_created: "yes",
              planned_changes_count: 3,
            },
            "validate-edit-plan": {
              validation_issues_count: 0,
            },
            "present-edit-plan": {
              plan_approval: "yes",
            },
            "apply-workflow-changes": {
              changes_applied: "yes",
              new_node_count: 5,
            },
            "review-changes-before-upload": {
              review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 14: Edit with plan validation failure
        {
          name: "Edit with plan validation failure",
          description: "Edit plan fails validation, gets fixed",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "edit",
              has_file_access: true,
              has_web_access: true,
            },
            "select-workflow-to-edit-online": {
              workflow_id_to_edit: "plan-fix-workflow",
            },
            "search-local-workflow-file": {
              local_workflow_path: "workflows/plan-fix-workflow.json",
            },
            "setup-workspace": {
              workspace_path: "./moira-ws/plan-fix-edit-20250115-1203/",
            },
            "load-workflow-for-edit": {
              workflow_loaded: "yes",
              current_node_count: 4,
              version_conflict: "no",
            },
            "gather-edit-requirements": {
              nodes_to_add: ["Add node"],
            },
            "create-edit-plan": {
              edit_plan: "Edit plan: add node-a, remove node-b",
              plan_created: "yes",
              planned_changes_count: 3,
            },
            // First fails, second passes
            "validate-edit-plan": [
              { validation_issues_count: 1, validation_issues: ["Missing connection"] },
              { validation_issues_count: 0 },
            ],
            "fix-edit-plan": {
              edit_plan: "Edit plan: add node-a, remove node-b",
              fixes_applied: "yes",
            },
            "present-edit-plan": {
              plan_approval: "yes",
            },
            "apply-workflow-changes": {
              changes_applied: "yes",
              new_node_count: 5,
            },
            "review-changes-before-upload": {
              review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 15: Edit with plan rejection
        {
          name: "Edit with plan rejection",
          description: "User rejects edit plan, revision loop",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "edit",
              has_file_access: true,
              has_web_access: true,
            },
            "select-workflow-to-edit-online": {
              workflow_id_to_edit: "plan-reject-workflow",
            },
            "search-local-workflow-file": {
              local_workflow_path: "workflows/plan-reject.json",
            },
            "setup-workspace": {
              workspace_path: "./moira-ws/plan-reject-edit-20250115-1204/",
            },
            "load-workflow-for-edit": {
              workflow_loaded: "yes",
              current_node_count: 3,
              version_conflict: "no",
            },
            "gather-edit-requirements": {
              nodes_to_add: ["Add step1"],
            },
            "create-edit-plan": {
              edit_plan: "Edit plan: add node-a, remove node-b",
              plan_created: "yes",
              planned_changes_count: 3,
            },
            "validate-edit-plan": [{ validation_issues_count: 0 }, { validation_issues_count: 0 }],
            // First rejects, second approves
            "present-edit-plan": [
              { plan_approval: "no", user_feedback: "Need different approach" },
              { plan_approval: "yes" },
            ],
            "revise-edit-plan": {
              plan_revised: "yes",
            },
            "apply-workflow-changes": {
              changes_applied: "yes",
              new_node_count: 5,
            },
            "review-changes-before-upload": {
              review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 16: Edit with review issues
        {
          name: "Edit with review issues",
          description: "Review before upload finds issues",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "edit",
              has_file_access: true,
              has_web_access: true,
            },
            "select-workflow-to-edit-online": {
              workflow_id_to_edit: "review-issues-workflow",
            },
            "search-local-workflow-file": {
              local_workflow_path: "workflows/review-issues.json",
            },
            "setup-workspace": {
              workspace_path: "./moira-ws/review-issues-edit-20250115-1205/",
            },
            "load-workflow-for-edit": {
              workflow_loaded: "yes",
              current_node_count: 5,
              version_conflict: "no",
            },
            "gather-edit-requirements": {
              nodes_to_update: ["Update step"],
            },
            "create-edit-plan": {
              edit_plan: "Edit plan: add node-a, remove node-b",
              plan_created: "yes",
              planned_changes_count: 3,
            },
            "validate-edit-plan": {
              validation_issues_count: 0,
            },
            "present-edit-plan": {
              plan_approval: "yes",
            },
            "apply-workflow-changes": {
              changes_applied: "yes",
              new_node_count: 5,
            },
            // First finds issues, second passes
            "review-changes-before-upload": [
              { review_issues_count: 1, review_issues: ["Incomplete change"] },
              { review_issues_count: 0 },
            ],
            "fix-review-issues": {
              fixes_applied: "yes",
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // === UPLOAD ERROR SCENARIOS ===

        // Scenario 17: Upload error - retry
        {
          name: "Upload error retry",
          description: "Upload fails, user retries",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "retry-upload",
              workflow_purpose: "Test workflow for retry functionality",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research phase completed with standard workflow patterns applicable to this scenario",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["S1", "S2"],
              stages_approved: "yes",
            },
            "review-stages-completeness": {
              stages_review_issues_count: 0,
            },
            "design-workflow-structure": {
              workflow_graph: "start → step-one → step-two → end",
              node_count: 4,
            },
            "approve-structure": {
              structure_approved: "yes",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": {
              implementation_review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            // First fails, second succeeds
            "save-workflow-to-target": [
              { upload_success: "no", upload_error: "Network error" },
              { upload_success: "yes" },
            ],
            "handle-upload-error": {
              error_action: "retry",
            },
            "prepare-retry-upload": {
              upload_force_new: true,
              upload_admin_override: false,
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 18: Upload error - skip
        {
          name: "Upload error skip",
          description: "Upload fails, user skips",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "skip-after-error",
              workflow_purpose: "Test workflow for skip functionality",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research phase completed with standard workflow patterns applicable to this scenario",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["S1", "S2"],
              stages_approved: "yes",
            },
            "review-stages-completeness": {
              stages_review_issues_count: 0,
            },
            "design-workflow-structure": {
              workflow_graph: "start → step-one → step-two → end",
              node_count: 4,
            },
            "approve-structure": {
              structure_approved: "yes",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": {
              implementation_review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "no",
              upload_error: "Server error",
            },
            "handle-upload-error": {
              error_action: "skip",
            },
            "sync-local-file": {
              sync_result: "synced",
            },
          },
        },

        // Scenario 19: Upload error - cancel
        {
          name: "Upload error cancel",
          description: "Upload fails, user cancels",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "cancel-workflow",
              workflow_purpose: "Test workflow for cancel functionality",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research phase completed with standard workflow patterns applicable to this scenario",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["S1", "S2"],
              stages_approved: "yes",
            },
            "review-stages-completeness": {
              stages_review_issues_count: 0,
            },
            "design-workflow-structure": {
              workflow_graph: "start → step-one → step-two → end",
              node_count: 4,
            },
            "approve-structure": {
              structure_approved: "yes",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": {
              implementation_review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "no",
              upload_error: "Auth error",
            },
            "handle-upload-error": {
              error_action: "cancel",
            },
            // Goes to end-cancelled
          },
        },

        // === NO FILE ACCESS SCENARIOS ===

        // Scenario 20: Create without file access
        {
          name: "Create without file access",
          description: "No file access, skip local sync",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: false,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "no-file-access",
              workflow_purpose: "Test workflow without file access",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research phase completed with standard workflow patterns applicable to this scenario",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": {
              patterns_confirmed: "yes",
            },
            "define-main-stages": {
              main_stages: ["S1", "S2"],
              stages_approved: "yes",
            },
            "review-stages-completeness": {
              stages_review_issues_count: 0,
            },
            "design-workflow-structure": {
              workflow_graph: "start → step-one → step-two → end",
              node_count: 4,
            },
            "approve-structure": {
              structure_approved: "yes",
            },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": {
              implementation_review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            // route-has-file-access-for-sync → false → end
          },
        },

        // Scenario 21: Edit without file access
        {
          name: "Edit without file access",
          description: "Edit online without local file access",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "edit",
              has_file_access: false,
              has_web_access: true,
            },
            "select-workflow-to-edit-online": {
              workflow_id_to_edit: "server-workflow",
            },
            // route-has-file-access → false → load-workflow-for-edit
            "load-workflow-for-edit": {
              workflow_loaded: "yes",
              current_node_count: 6,
              version_conflict: "no",
            },
            "gather-edit-requirements": {
              nodes_to_update: ["Update node"],
            },
            "create-edit-plan": {
              plan_created: "yes",
              planned_changes_count: 3,
              edit_plan:
                "## Target Workflow\n- ID: server-workflow\n\n## Planned Changes\n1. Update node directive\n2. Fix connections\n3. Add validation",
            },
            "validate-edit-plan": {
              validation_issues_count: 0,
            },
            "present-edit-plan": {
              plan_approval: "yes",
            },
            "apply-workflow-changes": {
              changes_applied: "yes",
              new_node_count: 5,
            },
            "review-changes-before-upload": {
              review_issues_count: 0,
            },
            "validate-workflow": {
              validation_passed: "yes",
            },
            "review-workflow-quality": {
              quality_review_issues_count: 0,
            },
            "user-final-review": {
              work_approved: "yes",
            },
            "ask-upload": {
              upload_confirmed: true,
            },
            "save-workflow-to-target": {
              upload_success: "yes",
            },
            // route-has-file-access-for-sync → false → end
          },
        },
        // === BOUNDED LOOP ESCAPE SCENARIOS ===
        // These cover the false branch of fix-limit conditions (counter >= max)

        // Scenario: Stages fix limit reached
        {
          name: "Stages fix limit escape",
          description: "Stages review fails 3 times, escapes to design-workflow-structure",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "stages-escape",
              workflow_purpose: "Test workflow for stages escape path when fix limit is reached",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": { patterns_confirmed: "yes" },
            "define-main-stages": { main_stages: ["S1", "S2"], stages_approved: "yes" },
            // 3 reviews all fail → counter reaches 3 → escape
            "review-stages-completeness": [
              { stages_review_issues_count: 1, stages_review_issues: ["Issue A"] },
              { stages_review_issues_count: 1, stages_review_issues: ["Issue B"] },
              { stages_review_issues_count: 1, stages_review_issues: ["Issue C"] },
            ],
            "fix-stages-issues": [
              { main_stages: ["S1", "S2"], fixes_applied: "Fix 1" },
              { main_stages: ["S1", "S2"], fixes_applied: "Fix 2" },
            ],
            "ask-user-stages-limit-reached": { decision: "continue" },
            // Escaped to design-workflow-structure
            "design-workflow-structure": {
              workflow_graph: "start → stage1 → stage2 → review → end",
              node_count: 5,
            },
            "approve-structure": { structure_approved: "yes" },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": { implementation_review_issues_count: 0 },
            "validate-workflow": { validation_passed: "yes" },
            "review-workflow-quality": { quality_review_issues_count: 0 },
            "user-final-review": { work_approved: "yes" },
            "ask-upload": { upload_confirmed: true },
            "save-workflow-to-target": { upload_success: "yes" },
            "sync-local-file": { sync_result: "synced" },
          },
        },

        // Scenario: Implementation fix limit reached
        {
          name: "Implementation fix limit escape",
          description: "Impl review fails 3 times, escapes to validate-workflow",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "impl-escape",
              workflow_purpose:
                "Test workflow for implementation escape path when fix limit is reached",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": { patterns_confirmed: "yes" },
            "define-main-stages": { main_stages: ["Stage1", "Stage2"], stages_approved: "yes" },
            "review-stages-completeness": { stages_review_issues_count: 0 },
            "design-workflow-structure": {
              workflow_graph: "start → stage1 → stage2 → review → end",
              node_count: 5,
            },
            "approve-structure": { structure_approved: "yes" },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            // 3 impl reviews fail → escape
            "review-implementation-completeness": [
              {
                implementation_review_issues_count: 2,
                implementation_review_issues: ["Missing node"],
              },
              {
                implementation_review_issues_count: 1,
                implementation_review_issues: ["Bad connection"],
              },
              {
                implementation_review_issues_count: 1,
                implementation_review_issues: ["Still wrong"],
              },
            ],
            "fix-implementation-issues": [{ fixes_applied: "yes" }, { fixes_applied: "yes" }],
            "ask-user-impl-limit-reached": { decision: "continue" },
            // Escaped to validate-workflow
            "validate-workflow": { validation_passed: "yes" },
            "review-workflow-quality": { quality_review_issues_count: 0 },
            "user-final-review": { work_approved: "yes" },
            "ask-upload": { upload_confirmed: true },
            "save-workflow-to-target": { upload_success: "yes" },
            "sync-local-file": { sync_result: "synced" },
          },
        },

        // Scenario: Quality fix limit reached
        {
          name: "Quality fix limit escape",
          description: "Quality review fails 3 times, escapes to user-final-review",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "quality-escape",
              workflow_purpose:
                "Test workflow for quality review escape path when fix limit is reached",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": { patterns_confirmed: "yes" },
            "define-main-stages": { main_stages: ["Stage1", "Stage2"], stages_approved: "yes" },
            "review-stages-completeness": { stages_review_issues_count: 0 },
            "design-workflow-structure": {
              workflow_graph: "start → stage1 → stage2 → review → end",
              node_count: 5,
            },
            "approve-structure": { structure_approved: "yes" },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": { implementation_review_issues_count: 0 },
            "validate-workflow": { validation_passed: "yes" },
            // 3 quality reviews fail → escape
            "review-workflow-quality": [
              {
                quality_review_issues_count: 2,
                quality_review_issues: ["Anti-pattern found in workflow"],
              },
              {
                quality_review_issues_count: 1,
                quality_review_issues: ["Another anti-pattern found"],
              },
              {
                quality_review_issues_count: 1,
                quality_review_issues: ["Persistent quality issue"],
              },
            ],
            "fix-quality-issues": [{ fixes_applied: "yes" }, { fixes_applied: "yes" }],
            "ask-user-quality-limit-reached": { decision: "continue" },
            // Escaped to user-final-review
            "user-final-review": { work_approved: "yes" },
            "ask-upload": { upload_confirmed: true },
            "save-workflow-to-target": { upload_success: "yes" },
            "sync-local-file": { sync_result: "synced" },
          },
        },

        // Scenario: Validation fix limit reached
        {
          name: "Validation fix limit escape",
          description: "Validation fails 3 times, escapes to review-workflow-quality",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "validation-escape",
              workflow_purpose:
                "Test workflow for validation escape path when fix limit is reached",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": { patterns_confirmed: "yes" },
            "define-main-stages": { main_stages: ["Stage1", "Stage2"], stages_approved: "yes" },
            "review-stages-completeness": { stages_review_issues_count: 0 },
            "design-workflow-structure": {
              workflow_graph: "start → stage1 → stage2 → review → end",
              node_count: 5,
            },
            "approve-structure": { structure_approved: "yes" },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": { implementation_review_issues_count: 0 },
            // 3 validations fail → escape
            "validate-workflow": [
              { validation_passed: "no", validation_errors: ["Error A"] },
              { validation_passed: "no", validation_errors: ["Error B"] },
              { validation_passed: "no", validation_errors: ["Error C"] },
            ],
            "fix-validation-errors": [
              { errors_fixed: "yes" },
              { errors_fixed: "yes" },
              { errors_fixed: "yes" },
            ],
            "ask-user-validation-limit-reached": { decision: "continue" },
            // Escaped to review-workflow-quality
            "review-workflow-quality": { quality_review_issues_count: 0 },
            "user-final-review": { work_approved: "yes" },
            "ask-upload": { upload_confirmed: true },
            "save-workflow-to-target": { upload_success: "yes" },
            "sync-local-file": { sync_result: "synced" },
          },
        },

        // Scenario: Review fix limit reached (edit flow only)
        {
          name: "Review fix limit escape",
          description: "Pre-upload review fails 3 times in edit flow, escapes to validate-workflow",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": { action_type: "edit", has_file_access: true, has_web_access: true },
            "select-workflow-to-edit-online": {
              workflow_id_to_edit: "review-escape-workflow",
            },
            "search-local-workflow-file": {
              local_workflow_path: "workflows/review-escape.json",
            },
            "setup-workspace": {
              workspace_path: "./moira-ws/review-escape-edit-20250115-1200/",
            },
            "load-workflow-for-edit": {
              workflow_loaded: "yes",
              current_node_count: 4,
              version_conflict: "no",
            },
            "gather-edit-requirements": {
              nodes_to_add: ["Add validation step to workflow"],
            },
            "create-edit-plan": {
              edit_plan: "Edit plan: add node-a, remove node-b",
              plan_created: "yes",
              planned_changes_count: 2,
            },
            "validate-edit-plan": { validation_issues_count: 0 },
            "present-edit-plan": { plan_approval: "yes" },
            "apply-workflow-changes": {
              changes_applied: "yes",
              new_node_count: 5,
            },
            // 3 pre-upload reviews fail → escape
            "review-changes-before-upload": [
              { review_issues_count: 1, review_issues: ["Typo in directive"] },
              { review_issues_count: 1, review_issues: ["Missing connection"] },
              { review_issues_count: 1, review_issues: ["Bad naming"] },
            ],
            "fix-review-issues": [{ fixes_applied: "yes" }, { fixes_applied: "yes" }],
            "ask-user-review-limit-reached": { decision: "continue" },
            // Escaped to validate-workflow
            "validate-workflow": { validation_passed: "yes" },
            "review-workflow-quality": { quality_review_issues_count: 0 },
            "user-final-review": { work_approved: "yes" },
            "ask-upload": { upload_confirmed: true },
            "save-workflow-to-target": { upload_success: "yes" },
            "sync-local-file": { sync_result: "synced" },
          },
        },

        // Scenario: Edit plan fix limit reached
        {
          name: "Edit plan fix limit escape",
          description: "Edit plan validation fails 3 times, escapes to present-edit-plan",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": { action_type: "edit", has_file_access: true, has_web_access: true },
            "select-workflow-to-edit-online": {
              workflow_id_to_edit: "editplan-escape-workflow",
            },
            "search-local-workflow-file": {
              local_workflow_path: "workflows/editplan-escape.json",
            },
            "setup-workspace": {
              workspace_path: "./moira-ws/editplan-escape-edit-20250115-1200/",
            },
            "load-workflow-for-edit": {
              workflow_loaded: "yes",
              current_node_count: 4,
              version_conflict: "no",
            },
            "gather-edit-requirements": {
              nodes_to_add: ["Add a new validation step between steps"],
            },
            "create-edit-plan": {
              edit_plan: "Edit plan: add node-a, remove node-b",
              plan_created: "yes",
              planned_changes_count: 3,
            },
            // 3 validations fail → escape
            "validate-edit-plan": [
              { validation_issues_count: 1, validation_issues: ["Missing connection to new node"] },
              { validation_issues_count: 1, validation_issues: ["Wrong node type specified"] },
              { validation_issues_count: 1, validation_issues: ["Still has structural issues"] },
            ],
            "fix-edit-plan": [{ fixes_applied: "yes" }, { fixes_applied: "yes" }],
            "ask-user-editplan-limit-reached": { decision: "continue" },
            // Escaped to present-edit-plan
            "present-edit-plan": { plan_approval: "yes" },
            "apply-workflow-changes": {
              changes_applied: "yes",
              new_node_count: 5,
            },
            "review-changes-before-upload": { review_issues_count: 0 },
            "validate-workflow": { validation_passed: "yes" },
            "review-workflow-quality": { quality_review_issues_count: 0 },
            "user-final-review": { work_approved: "yes" },
            "ask-upload": { upload_confirmed: true },
            "save-workflow-to-target": { upload_success: "yes" },
            "sync-local-file": { sync_result: "synced" },
          },
        },

        // Scenario: Stages fix limit reset
        {
          name: "Stages fix limit reset",
          description: "Stages review fails 3 times, user resets counter, fix succeeds on retry",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "stages-reset",
              workflow_purpose: "Test workflow for stages reset path",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": { patterns_confirmed: "yes" },
            "define-main-stages": { main_stages: ["S1", "S2"], stages_approved: "yes" },
            // 3 reviews fail → limit reached → reset → fix → review passes
            "review-stages-completeness": [
              { stages_review_issues_count: 1, stages_review_issues: ["Issue A"] },
              { stages_review_issues_count: 1, stages_review_issues: ["Issue B"] },
              { stages_review_issues_count: 1, stages_review_issues: ["Issue C"] },
              { stages_review_issues_count: 0 },
            ],
            "fix-stages-issues": [
              { main_stages: ["S1", "S2"], fixes_applied: "Fix 1" },
              { main_stages: ["S1", "S2"], fixes_applied: "Fix 2" },
              { main_stages: ["S1", "S2"], fixes_applied: "Fix 3 after reset" },
            ],
            "ask-user-stages-limit-reached": { decision: "reset" },
            "design-workflow-structure": {
              workflow_graph: "start → stage1 → stage2 → review → end",
              node_count: 5,
            },
            "approve-structure": { structure_approved: "yes" },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": { implementation_review_issues_count: 0 },
            "validate-workflow": { validation_passed: "yes" },
            "review-workflow-quality": { quality_review_issues_count: 0 },
            "user-final-review": { work_approved: "yes" },
            "ask-upload": { upload_confirmed: true },
            "save-workflow-to-target": { upload_success: "yes" },
            "sync-local-file": { sync_result: "synced" },
          },
        },

        // Scenario: Implementation fix limit reset
        {
          name: "Implementation fix limit reset",
          description: "Impl review fails 3 times, user resets counter, fix succeeds on retry",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "impl-reset",
              workflow_purpose: "Test workflow for impl reset path",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": { patterns_confirmed: "yes" },
            "define-main-stages": { main_stages: ["Stage1", "Stage2"], stages_approved: "yes" },
            "review-stages-completeness": { stages_review_issues_count: 0 },
            "design-workflow-structure": {
              workflow_graph: "start → stage1 → stage2 → review → end",
              node_count: 5,
            },
            "approve-structure": { structure_approved: "yes" },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            // 3 impl reviews fail → reset → fix → review passes
            "review-implementation-completeness": [
              { implementation_review_issues_count: 1, implementation_review_issues: ["Issue"] },
              { implementation_review_issues_count: 1, implementation_review_issues: ["Issue"] },
              { implementation_review_issues_count: 1, implementation_review_issues: ["Issue"] },
              { implementation_review_issues_count: 0 },
            ],
            "fix-implementation-issues": [
              { fixes_applied: "yes" },
              { fixes_applied: "yes" },
              { fixes_applied: "yes" },
            ],
            "ask-user-impl-limit-reached": { decision: "reset" },
            "validate-workflow": { validation_passed: "yes" },
            "review-workflow-quality": { quality_review_issues_count: 0 },
            "user-final-review": { work_approved: "yes" },
            "ask-upload": { upload_confirmed: true },
            "save-workflow-to-target": { upload_success: "yes" },
            "sync-local-file": { sync_result: "synced" },
          },
        },

        // Scenario: Quality fix limit reset
        {
          name: "Quality fix limit reset",
          description: "Quality review fails 3 times, user resets counter, fix succeeds on retry",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "quality-reset",
              workflow_purpose: "Test workflow for quality reset path",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": { patterns_confirmed: "yes" },
            "define-main-stages": { main_stages: ["Stage1", "Stage2"], stages_approved: "yes" },
            "review-stages-completeness": { stages_review_issues_count: 0 },
            "design-workflow-structure": {
              workflow_graph: "start → stage1 → stage2 → review → end",
              node_count: 5,
            },
            "approve-structure": { structure_approved: "yes" },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": { implementation_review_issues_count: 0 },
            "validate-workflow": { validation_passed: "yes" },
            // 3 quality reviews fail → reset → fix → review passes
            "review-workflow-quality": [
              { quality_review_issues_count: 1, quality_review_issues: ["Anti-pattern"] },
              { quality_review_issues_count: 1, quality_review_issues: ["Anti-pattern"] },
              { quality_review_issues_count: 1, quality_review_issues: ["Anti-pattern"] },
              { quality_review_issues_count: 0 },
            ],
            "fix-quality-issues": [
              { fixes_applied: "yes" },
              { fixes_applied: "yes" },
              { fixes_applied: "yes" },
            ],
            "ask-user-quality-limit-reached": { decision: "reset" },
            "user-final-review": { work_approved: "yes" },
            "ask-upload": { upload_confirmed: true },
            "save-workflow-to-target": { upload_success: "yes" },
            "sync-local-file": { sync_result: "synced" },
          },
        },

        // Scenario: Validation fix limit reset
        {
          name: "Validation fix limit reset",
          description: "Validation fails 3 times, user resets counter, fix succeeds on retry",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": {
              action_type: "create",
              has_file_access: true,
              has_web_access: true,
            },
            "gather-workflow-requirements": {
              workflow_name: "validation-reset",
              workflow_purpose: "Test workflow for validation reset path",
              visibility: "private",
              use_pattern_validation_loop: false,
              use_pattern_info_collection: false,
              use_pattern_skip: false,
              use_pattern_workspace: false,
              use_pattern_subagent_review: false,
              use_pattern_step_validation: false,
              use_pattern_artifacts_publishing: false,
              use_pattern_notes_persistence: false,
            },
            "research-domain-practices": {
              domain_research_summary:
                "Research completed successfully with no special domain knowledge required for this workflow",
              needs_domain_knowledge: false,
            },
            "analyze-and-propose": { patterns_confirmed: "yes" },
            "define-main-stages": { main_stages: ["Stage1", "Stage2"], stages_approved: "yes" },
            "review-stages-completeness": { stages_review_issues_count: 0 },
            "design-workflow-structure": {
              workflow_graph: "start → stage1 → stage2 → review → end",
              node_count: 5,
            },
            "approve-structure": { structure_approved: "yes" },
            "create-workflow-json": {
              workflow_json_created: "yes",
              total_nodes: 3,
              workspace_path: "./test-flow/",
            },
            "review-implementation-completeness": { implementation_review_issues_count: 0 },
            // 3 validations fail → reset → validate passes
            "validate-workflow": [
              { validation_passed: "no", validation_errors: ["Error A"] },
              { validation_passed: "no", validation_errors: ["Error B"] },
              { validation_passed: "no", validation_errors: ["Error C"] },
              { validation_passed: "yes" },
            ],
            "fix-validation-errors": [
              { errors_fixed: "yes" },
              { errors_fixed: "yes" },
              { errors_fixed: "yes" },
            ],
            "ask-user-validation-limit-reached": { decision: "reset" },
            "review-workflow-quality": { quality_review_issues_count: 0 },
            "user-final-review": { work_approved: "yes" },
            "ask-upload": { upload_confirmed: true },
            "save-workflow-to-target": { upload_success: "yes" },
            "sync-local-file": { sync_result: "synced" },
          },
        },

        // Scenario: Review fix limit reset (edit flow only)
        {
          name: "Review fix limit reset",
          description:
            "Pre-upload review fails 3 times in edit flow, user resets, fix succeeds on retry",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": { action_type: "edit", has_file_access: true, has_web_access: true },
            "select-workflow-to-edit-online": {
              workflow_id_to_edit: "review-reset-workflow",
            },
            "search-local-workflow-file": {
              local_workflow_path: "workflows/review-reset.json",
            },
            "setup-workspace": {
              workspace_path: "./moira-ws/review-reset-edit-20250115-1200/",
            },
            "load-workflow-for-edit": {
              workflow_loaded: "yes",
              current_node_count: 4,
              version_conflict: "no",
            },
            "gather-edit-requirements": {
              nodes_to_add: ["Add validation step"],
            },
            "create-edit-plan": {
              edit_plan: "Edit plan: add node-a, remove node-b",
              plan_created: "yes",
              planned_changes_count: 2,
            },
            "validate-edit-plan": { validation_issues_count: 0 },
            "present-edit-plan": { plan_approval: "yes" },
            "apply-workflow-changes": {
              changes_applied: "yes",
              new_node_count: 5,
            },
            // 3 reviews fail → reset → fix → review passes
            "review-changes-before-upload": [
              { review_issues_count: 1, review_issues: ["Typo"] },
              { review_issues_count: 1, review_issues: ["Typo"] },
              { review_issues_count: 1, review_issues: ["Typo"] },
              { review_issues_count: 0 },
            ],
            "fix-review-issues": [
              { fixes_applied: "yes" },
              { fixes_applied: "yes" },
              { fixes_applied: "yes" },
            ],
            "ask-user-review-limit-reached": { decision: "reset" },
            "validate-workflow": { validation_passed: "yes" },
            "review-workflow-quality": { quality_review_issues_count: 0 },
            "user-final-review": { work_approved: "yes" },
            "ask-upload": { upload_confirmed: true },
            "save-workflow-to-target": { upload_success: "yes" },
            "sync-local-file": { sync_result: "synced" },
          },
        },

        // Scenario: Edit plan fix limit reset
        {
          name: "Edit plan fix limit reset",
          description: "Edit plan validation fails 3 times, user resets, fix succeeds on retry",
          expect: { status: "completed" },
          mockInputs: {
            "get-action-type": { action_type: "edit", has_file_access: true, has_web_access: true },
            "select-workflow-to-edit-online": {
              workflow_id_to_edit: "editplan-reset-workflow",
            },
            "search-local-workflow-file": {
              local_workflow_path: "workflows/editplan-reset.json",
            },
            "setup-workspace": {
              workspace_path: "./moira-ws/editplan-reset-edit-20250115-1200/",
            },
            "load-workflow-for-edit": {
              workflow_loaded: "yes",
              current_node_count: 4,
              version_conflict: "no",
            },
            "gather-edit-requirements": {
              nodes_to_add: ["Add a new step"],
            },
            "create-edit-plan": {
              edit_plan: "Edit plan: add node-a, remove node-b",
              plan_created: "yes",
              planned_changes_count: 3,
            },
            // 3 validations fail → reset → validate passes
            "validate-edit-plan": [
              { validation_issues_count: 1, validation_issues: ["Issue"] },
              { validation_issues_count: 1, validation_issues: ["Issue"] },
              { validation_issues_count: 1, validation_issues: ["Issue"] },
              { validation_issues_count: 0 },
            ],
            "fix-edit-plan": [
              { fixes_applied: "yes" },
              { fixes_applied: "yes" },
              { fixes_applied: "yes" },
            ],
            "ask-user-editplan-limit-reached": { decision: "reset" },
            "present-edit-plan": { plan_approval: "yes" },
            "apply-workflow-changes": {
              changes_applied: "yes",
              new_node_count: 5,
            },
            "review-changes-before-upload": { review_issues_count: 0 },
            "validate-workflow": { validation_passed: "yes" },
            "review-workflow-quality": { quality_review_issues_count: 0 },
            "user-final-review": { work_approved: "yes" },
            "ask-upload": { upload_confirmed: true },
            "save-workflow-to-target": { upload_success: "yes" },
            "sync-local-file": { sync_result: "synced" },
          },
        },
      ];

      // Run all scenarios
      const results: ScenarioResult[] = [];
      for (const scenario of scenarios) {
        const result = await runScenario(workflow, scenario);
        results.push(result);
      }

      // Calculate coverage
      const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });

      // Log coverage report
      console.log(formatCoverageReport(coverage, "workflow-management-flow"));

      // Verify all scenarios passed
      const failedScenarios = results.filter((r) => !r.passed);
      if (failedScenarios.length > 0) {
        // Build diagnostic message for expect assertion
        const diagnosticLines: string[] = [
          "",
          "=".repeat(80),
          "FAILED SCENARIOS DIAGNOSTICS",
          "=".repeat(80),
        ];

        failedScenarios.forEach((s) => {
          diagnosticLines.push("");
          diagnosticLines.push("─".repeat(80));
          diagnosticLines.push(`SCENARIO: ${s.scenario}`);
          diagnosticLines.push(`STATUS: ${s.status}, STEPS: ${s.stepCount}`);
          diagnosticLines.push("─".repeat(80));
          if (s.error) {
            diagnosticLines.push(s.error);
          }
          if (s.failedExpectations && s.failedExpectations.length > 0) {
            diagnosticLines.push("");
            diagnosticLines.push("Failed expectations:");
            s.failedExpectations.forEach((exp) => diagnosticLines.push(`  - ${exp}`));
          }
        });

        diagnosticLines.push("");
        diagnosticLines.push("=".repeat(80));

        // Fail with full diagnostics in error message
        throw new Error(
          `${failedScenarios.length} scenario(s) failed:\n${diagnosticLines.join("\n")}`,
        );
      }

      expect(coverage.nodeCoverage).toBe(100);
      expect(coverage.branchCoverage).toBe(100);
    }, 120000); // 2 minute timeout for all scenarios
  });
});
