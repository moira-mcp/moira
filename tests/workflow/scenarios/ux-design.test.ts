/**
 * ux-design Scenario Tests
 *
 * Linear UX design workflow for creating user experiences.
 * Path: users → constraints → design-system → flow → microcopy → accessibility → prototype → validation → end
 *
 * Coverage target: 100% nodes (10), 100% branches
 */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  runScenario,
  type TestScenario,
  type ScenarioResult,
} from "../../helpers/scenario-runner.js";
import { calculateCoverage, formatCoverageReport } from "../../helpers/coverage-calculator.js";
import { GraphValidator, detectCycles } from "@mcp-moira/workflow-engine";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

function loadProductionWorkflow(): WorkflowGraph {
  return findSystemCatalogEntry("ux-design", "public")!.graph as WorkflowGraph;
}

describe("ux-design Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "ux-design"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have no cycles (linear workflow)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles).toHaveLength(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(10);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        // Scenario 1: Complete UX design flow
        {
          name: "Complete UX design workflow",
          description: "Full UX design process for a feature",
          expect: { status: "completed" },
          mockInputs: {
            users: {
              personas: [
                {
                  name: "Sarah",
                  role: "Product Manager",
                  context: "Office desktop",
                  jtbd: ["Quick navigation", "Dashboard overview"],
                  pain_points: ["Slow load times"],
                },
                {
                  name: "Mike",
                  role: "Developer",
                  context: "Remote laptop",
                  jtbd: ["Clear feedback", "API access"],
                  pain_points: ["Unclear errors"],
                },
              ],
              primary_persona: "Sarah",
            },
            constraints: {
              technical: ["Must work on mobile", "Load under 3s"],
              existing_patterns: ["Button component", "Modal patterns"],
              business: ["Consistent with brand", "Launch in Q1"],
            },
            "design-system": {
              existing_components: ["Button", "Input", "Modal", "Card"],
              reusable: ["Button", "Input"],
              new_needed: ["FeatureCard"],
            },
            flow: {
              steps: [
                {
                  name: "Login",
                  user_sees: "Login form",
                  rationale: "Authentication required first",
                  user_actions: ["Enter credentials", "Click login"],
                },
                {
                  name: "Dashboard",
                  user_sees: "Overview with metrics",
                  rationale: "Show context before actions",
                  user_actions: ["View stats", "Navigate"],
                },
              ],
            },
            microcopy: {
              copy: [
                { element: "button", text: "Save Changes", clarity_check: "yes - clear action" },
                { element: "button", text: "Discard", clarity_check: "yes - clear consequence" },
                {
                  element: "error",
                  text: "This field is required",
                  clarity_check: "yes - explains issue",
                },
              ],
            },
            accessibility: {
              checklist: [
                { requirement: "ARIA labels", how_addressed: "Added to all interactive elements" },
                { requirement: "Keyboard navigation", how_addressed: "Tab order and focus states" },
                { requirement: "Color contrast", how_addressed: "4.5:1 ratio verified" },
                { requirement: "Screen reader", how_addressed: "Tested with VoiceOver" },
                {
                  requirement: "Focus indicators",
                  how_addressed: "Visible focus ring on all elements",
                },
              ],
            },
            prototype: {
              screens: [
                {
                  name: "Dashboard",
                  layout: "Grid with metrics cards",
                  interactions: ["Click card", "Navigate"],
                },
                {
                  name: "Create form",
                  layout: "Centered form with sidebar",
                  interactions: ["Fill fields", "Submit"],
                },
                {
                  name: "Confirmation",
                  layout: "Success message with actions",
                  interactions: ["Return home", "View details"],
                },
              ],
            },
            validation: {
              hypotheses: ["Users can complete create flow in under 2 minutes"],
              method: "Usability testing",
              success_criteria: ["80% task completion rate"],
              participants: { count: 5, criteria: ["Target persona match"] },
            },
          },
        },

        // Scenario 2: Simple UX design
        {
          name: "Simple UX design",
          description: "Minimal UX design for small feature",
          expect: { status: "completed" },
          mockInputs: {
            users: {
              personas: [
                {
                  name: "End User",
                  role: "User",
                  context: "Desktop browser",
                  jtbd: ["Submit forms quickly"],
                },
              ],
              primary_persona: "End User",
            },
            constraints: {
              technical: ["Desktop only"],
              existing_patterns: ["Standard form"],
            },
            "design-system": {
              existing_components: ["Form"],
              reusable: ["Form"],
            },
            flow: {
              steps: [
                { name: "Input", user_sees: "Form fields", rationale: "Simple single-step flow" },
              ],
            },
            microcopy: {
              copy: [{ element: "button", text: "Submit", clarity_check: "yes - standard action" }],
            },
            accessibility: {
              checklist: [
                { requirement: "ARIA labels", how_addressed: "Added to form elements" },
                { requirement: "Keyboard navigation", how_addressed: "Standard form tabbing" },
                { requirement: "Color contrast", how_addressed: "Default theme passes" },
                { requirement: "Error messages", how_addressed: "Associated with fields" },
                { requirement: "Focus indicators", how_addressed: "Browser defaults" },
              ],
            },
            prototype: {
              screens: [
                {
                  name: "Form screen",
                  layout: "Simple centered form",
                  interactions: ["Fill fields", "Submit"],
                },
              ],
            },
            validation: {
              hypotheses: ["Users can submit form"],
              method: "Informal review",
              success_criteria: ["Form submission works"],
            },
          },
        },

        // Scenario 3: Complex enterprise UX
        {
          name: "Complex enterprise UX design",
          description: "Detailed UX for enterprise dashboard",
          expect: { status: "completed" },
          mockInputs: {
            users: {
              personas: [
                {
                  name: "Admin Amy",
                  role: "Admin",
                  context: "Office workstation",
                  jtbd: ["User management", "Access control"],
                  pain_points: ["Complex permissions"],
                },
                {
                  name: "Analyst Alex",
                  role: "Analyst",
                  context: "Dual monitor setup",
                  jtbd: ["Create reports", "Data analysis"],
                  pain_points: ["Slow exports"],
                },
                {
                  name: "Exec Emma",
                  role: "Executive",
                  context: "Mobile and tablet",
                  jtbd: ["View high-level metrics"],
                  pain_points: ["Too much detail"],
                },
              ],
              primary_persona: "Analyst Alex",
            },
            constraints: {
              technical: ["Support IE11", "Work offline", "Handle 10k records"],
              existing_patterns: ["Master-detail", "Wizard", "Dashboard"],
              business: ["Enterprise security", "White-label ready", "GDPR compliant"],
            },
            "design-system": {
              existing_components: ["DataGrid", "Chart", "Filter", "Export", "DatePicker"],
              reusable: ["DataGrid", "Chart"],
              new_needed: ["AdvancedFilter", "BatchActions"],
              integration_notes: "Must work with existing design tokens",
            },
            flow: {
              steps: [
                {
                  name: "Login",
                  user_sees: "SSO login page",
                  rationale: "Enterprise auth required",
                  user_actions: ["SSO login"],
                },
                {
                  name: "Role Selection",
                  user_sees: "Role picker",
                  rationale: "Different views per role",
                  user_actions: ["Select role"],
                },
                {
                  name: "Dashboard",
                  user_sees: "Role-specific dashboard",
                  rationale: "Contextual starting point",
                  user_actions: ["View metrics", "Drill down"],
                },
              ],
            },
            microcopy: {
              copy: [
                { element: "button", text: "Save Changes", clarity_check: "yes - clear action" },
                {
                  element: "button",
                  text: "Export to Excel",
                  clarity_check: "yes - specific format",
                },
                {
                  element: "button",
                  text: "Apply Filters",
                  clarity_check: "yes - describes action",
                },
                {
                  element: "error",
                  text: "Your session has expired. Please log in again.",
                  clarity_check: "yes - explains issue and next step",
                },
                {
                  element: "error",
                  text: "This record was modified. Refresh to see changes.",
                  clarity_check: "yes - explains conflict and resolution",
                },
              ],
            },
            accessibility: {
              checklist: [
                { requirement: "ARIA labels", how_addressed: "All interactive elements labeled" },
                {
                  requirement: "Keyboard navigation",
                  how_addressed: "Full keyboard support with shortcuts",
                },
                { requirement: "Focus trap", how_addressed: "Implemented in all modals" },
                { requirement: "Live regions", how_addressed: "Used for dynamic updates" },
                { requirement: "Skip links", how_addressed: "Added to main content" },
                { requirement: "Semantic landmarks", how_addressed: "Header, main, nav, footer" },
                { requirement: "WCAG AAA", how_addressed: "Key flows tested and verified" },
              ],
            },
            prototype: {
              screens: [
                {
                  name: "Dashboard - Empty state",
                  layout: "Centered empty state message",
                  interactions: ["Add first item"],
                },
                {
                  name: "Dashboard - Loaded",
                  layout: "Grid with data cards",
                  interactions: ["Filter", "Export", "Drill down"],
                },
                {
                  name: "Filter panel",
                  layout: "Slide-out panel",
                  interactions: ["Select filters", "Apply", "Clear"],
                },
                {
                  name: "Export dialog",
                  layout: "Modal with options",
                  interactions: ["Select format", "Export"],
                },
                {
                  name: "Error states",
                  layout: "Inline error messages",
                  interactions: ["Retry", "Dismiss"],
                },
              ],
            },
            validation: {
              hypotheses: [
                "Analysts can create report in 5 clicks",
                "Export workflow is discoverable",
              ],
              method: "Usability testing across 3 roles",
              success_criteria: ["85% task success rate for primary flows"],
              participants: { count: 12, criteria: ["Role diversity", "Experience levels"] },
            },
          },
        },
      ];

      const results: ScenarioResult[] = [];
      for (const scenario of scenarios) {
        const result = await runScenario(workflow, scenario);
        results.push(result);
      }

      const coverage = calculateCoverage(workflow, results, {
        includeGapAnalysis: true,
      });

      console.log(formatCoverageReport(coverage));

      const failedScenarios = results.filter((r) => !r.passed);
      if (failedScenarios.length > 0) {
        console.error("Failed scenarios:");
        for (const s of failedScenarios) {
          console.error(`  - ${s.scenario}: ${s.error || s.failedExpectations?.join(", ")}`);
        }
      }
      expect(failedScenarios).toHaveLength(0);

      expect(coverage.nodeCoverage).toBe(100);
      expect(coverage.branchCoverage).toBe(100);
    });
  });
});
