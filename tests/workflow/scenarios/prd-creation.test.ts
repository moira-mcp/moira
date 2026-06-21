/**
 * prd-creation Scenario Tests
 *
 * Linear PRD creation workflow for product requirements.
 * Path: problem → research → solution → user-stories → edge-cases → metrics → assumptions → output → end
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
  return findSystemCatalogEntry("prd-creation", "public")!.graph as WorkflowGraph;
}

describe("prd-creation Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "prd-creation"}`, ...workflow };
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
        // Scenario 1: Complete PRD creation
        {
          name: "Complete PRD creation workflow",
          description: "Full PRD creation with all sections",
          expect: { status: "completed" },
          mockInputs: {
            problem: {
              problem_statement: "Users cannot track order status in real-time",
              target_users: [
                { name: "E-commerce Customer", role: "End User" },
                { name: "Support Agent", role: "Internal Staff" },
              ],
              urgency_reason: "30% of support tickets are about order status",
              cost_of_inaction: "Growing support costs and customer churn",
            },
            research: {
              data_sources: [
                { source: "Customer surveys", key_finding: "Customers check status 5x per order" },
                { source: "Support ticket analysis", key_finding: "30% tickets are order status" },
              ],
              key_insights: [
                "Customers check status 5x per order",
                "Real-time updates reduce support tickets by 40%",
              ],
              competitor_solutions: [
                { competitor: "Amazon", how_they_solve: "Real-time tracking with map" },
                { competitor: "FedEx", how_they_solve: "SMS notifications", gaps: "No map view" },
              ],
            },
            solution: {
              solution_description: "Real-time order tracking dashboard with push notifications",
              in_scope: ["Tracking API", "Push notifications", "Map integration"],
              out_of_scope: ["Carrier management", "Return tracking"],
              why_this_approach: "Addresses core pain point with minimal complexity",
            },
            "user-stories": {
              stories: [
                {
                  user: "Customer",
                  action: "see my order location on a map",
                  outcome: "know when my package arrives",
                  acceptance_criteria: [
                    "Map shows real-time location",
                    "ETA displayed",
                    "Updates every 5 min",
                  ],
                },
                {
                  user: "Customer",
                  action: "receive push notifications",
                  outcome: "stay informed about status changes",
                  acceptance_criteria: [
                    "Notification on status change",
                    "Configurable preferences",
                    "Works on mobile",
                  ],
                },
                {
                  user: "Customer",
                  action: "see estimated delivery time",
                  outcome: "plan my day accordingly",
                  acceptance_criteria: [
                    "ETA updates dynamically",
                    "Shows time window",
                    "Historical accuracy 90%",
                  ],
                },
              ],
            },
            "edge-cases": {
              edge_cases: [
                {
                  scenario: "Multiple items shipped separately",
                  expected_behavior: "Show each shipment separately",
                },
                {
                  scenario: "International shipping delays",
                  expected_behavior: "Show delay reason and updated ETA",
                },
                {
                  scenario: "Carrier API downtime",
                  expected_behavior: "Show last known status with timestamp",
                },
                {
                  scenario: "No tracking number yet",
                  expected_behavior: "Show 'Preparing for shipment'",
                },
                {
                  scenario: "Delivery attempted but failed",
                  expected_behavior: "Show retry schedule",
                },
              ],
              error_states: [
                { error: "No tracking data available", user_message: "Tracking info coming soon" },
                { error: "Stale location data", user_message: "Last update: X hours ago" },
              ],
            },
            metrics: {
              primary_metric: {
                name: "Support ticket reduction",
                target_value: "50% reduction",
                how_to_measure: "Compare monthly tickets before/after",
                timeline: "3 months",
              },
              success_threshold: "40% reduction within 3 months",
              secondary_metrics: [
                { name: "NPS improvement", target: "+10 points" },
                { name: "App engagement", target: "20% increase" },
              ],
            },
            assumptions: {
              assumptions: [
                {
                  statement: "Carriers provide webhook APIs",
                  validation_method: "API documentation review",
                },
                {
                  statement: "Users have push notifications enabled",
                  validation_method: "Analytics data check",
                },
              ],
              risks: [
                {
                  description: "API rate limits",
                  probability: "medium",
                  impact: "high",
                  mitigation: "Implement caching",
                },
                {
                  description: "Data accuracy from carriers",
                  probability: "low",
                  impact: "medium",
                  mitigation: "Show last known good data",
                },
              ],
            },
            output: {
              prd_delivered: "yes",
              sections_count: 8,
              open_questions: ["Integration timeline with carriers"],
            },
          },
        },

        // Scenario 2: Simple PRD
        {
          name: "Simple PRD - minimal inputs",
          description: "PRD for small feature with minimal data",
          expect: { status: "completed" },
          mockInputs: {
            problem: {
              problem_statement: "Users want dark mode",
              target_users: [{ name: "App User", role: "End User" }],
              urgency_reason: "Requested by 50 users in feedback",
            },
            research: {
              data_sources: [
                { source: "User feedback", key_finding: "50 users requested dark mode" },
                { source: "UX research", key_finding: "Dark mode reduces eye strain" },
              ],
              key_insights: ["Dark mode improves eye comfort for night use"],
              competitor_solutions: [
                { competitor: "Slack", how_they_solve: "System-wide dark mode toggle" },
              ],
            },
            solution: {
              solution_description: "Add dark mode toggle in settings",
              in_scope: ["Theme toggle", "CSS variables"],
              out_of_scope: ["System theme sync"],
            },
            "user-stories": {
              stories: [
                {
                  user: "User",
                  action: "toggle dark mode in settings",
                  outcome: "have a comfortable viewing experience at night",
                  acceptance_criteria: [
                    "Toggle is visible in settings",
                    "Theme changes immediately",
                    "Preference persists",
                  ],
                },
                {
                  user: "User",
                  action: "see dark mode applied to all screens",
                  outcome: "have consistent dark theme everywhere",
                  acceptance_criteria: [
                    "All screens use dark theme",
                    "Text is readable",
                    "Images have good contrast",
                  ],
                },
                {
                  user: "User",
                  action: "switch back to light mode",
                  outcome: "return to default appearance",
                  acceptance_criteria: [
                    "Toggle works both ways",
                    "No flash on switch",
                    "Smooth transition",
                  ],
                },
              ],
            },
            "edge-cases": {
              edge_cases: [
                {
                  scenario: "Theme preference persistence across devices",
                  expected_behavior: "Sync via user account",
                },
                { scenario: "First app launch", expected_behavior: "Default to light mode" },
                {
                  scenario: "Images with transparency",
                  expected_behavior: "Apply appropriate background",
                },
                { scenario: "Email templates", expected_behavior: "Stay light for compatibility" },
                { scenario: "Print mode", expected_behavior: "Force light theme" },
              ],
            },
            metrics: {
              primary_metric: {
                name: "Dark mode adoption",
                target_value: "20% of users",
                how_to_measure: "Analytics: users with dark mode enabled",
              },
              success_threshold: "20% of users enable dark mode",
            },
            assumptions: {
              assumptions: [
                {
                  statement: "CSS variables are supported by target browsers",
                  validation_method: "Browser compatibility check",
                },
              ],
              risks: [
                {
                  description: "Some third-party components may not support dark mode",
                  probability: "low",
                  impact: "medium",
                  mitigation: "Audit components beforehand",
                },
              ],
            },
            output: {
              prd_delivered: "yes",
              sections_count: 7,
            },
          },
        },

        // Scenario 3: Comprehensive PRD
        {
          name: "Comprehensive PRD - detailed analysis",
          description: "Full PRD with extensive research and analysis",
          expect: { status: "completed" },
          mockInputs: {
            problem: {
              problem_statement: "Manual invoice processing takes 2 hours per day",
              target_users: [
                { name: "AP Clerk", role: "Data Entry" },
                { name: "AP Manager", role: "Approver" },
                { name: "CFO", role: "Executive" },
              ],
              urgency_reason: "Scaling issues as invoice volume grows",
              cost_of_inaction: "$50k annual cost in processing time",
            },
            research: {
              data_sources: [
                {
                  source: "Competitive analysis",
                  key_finding: "Top tools use AI/ML for extraction",
                },
                {
                  source: "Customer interviews",
                  key_finding: "2 hours daily spent on manual entry",
                },
                {
                  source: "Technical research",
                  key_finding: "OCR accuracy at 95% for standard formats",
                },
              ],
              key_insights: [
                "OCR accuracy at 95% for standard formats",
                "70% of SMBs want automated invoicing",
              ],
              competitor_solutions: [
                {
                  competitor: "QuickBooks",
                  how_they_solve: "Automated data capture",
                  gaps: "Limited ERP integration",
                },
                {
                  competitor: "Sage",
                  how_they_solve: "AI-powered extraction",
                  gaps: "Higher cost",
                },
              ],
              previous_attempts: ["Manual OCR tool trial - accuracy too low"],
            },
            solution: {
              solution_description: "AI-powered invoice processing with ML extraction",
              in_scope: [
                "OCR document scanning",
                "ML field extraction",
                "ERP integration",
                "Approval workflow",
              ],
              out_of_scope: ["Payment processing", "Vendor management"],
              why_this_approach: "Highest ROI based on cost analysis",
              constraints: ["Must integrate with existing ERP"],
            },
            "user-stories": {
              stories: [
                {
                  user: "AP Clerk",
                  action: "scan invoices with my phone",
                  outcome: "automatically extract invoice data",
                  acceptance_criteria: [
                    "Camera capture works",
                    "OCR extracts key fields",
                    "Data appears in system",
                  ],
                },
                {
                  user: "Manager",
                  action: "approve invoices on mobile",
                  outcome: "process approvals from anywhere",
                  acceptance_criteria: [
                    "Mobile app works",
                    "Push notifications",
                    "One-tap approval",
                  ],
                },
                {
                  user: "CFO",
                  action: "see real-time spending dashboard",
                  outcome: "monitor company expenses",
                  acceptance_criteria: [
                    "Real-time data",
                    "Drill-down capability",
                    "Export to Excel",
                  ],
                },
              ],
            },
            "edge-cases": {
              edge_cases: [
                { scenario: "Handwritten invoices", expected_behavior: "Flag for manual review" },
                {
                  scenario: "Multi-page invoices",
                  expected_behavior: "Combine pages into single document",
                },
                {
                  scenario: "Foreign currency",
                  expected_behavior: "Auto-convert with rate lookup",
                },
                { scenario: "Duplicate invoices", expected_behavior: "Detect and warn user" },
                {
                  scenario: "Partial data extraction",
                  expected_behavior: "Highlight missing fields",
                },
              ],
              error_states: [
                { error: "OCR failure", user_message: "Could not read document. Please rescan." },
                {
                  error: "Unrecognized format",
                  user_message: "Unknown format. Manual entry required.",
                },
                { error: "Duplicate detection", user_message: "This invoice may be a duplicate." },
              ],
            },
            metrics: {
              primary_metric: {
                name: "Processing time reduction",
                target_value: "80% reduction",
                how_to_measure: "Time tracking before/after implementation",
                timeline: "6 months",
              },
              success_threshold: "75% reduction in 6 months",
              secondary_metrics: [
                { name: "Error rate", target: "Below 1%" },
                { name: "User adoption", target: "90%" },
              ],
            },
            assumptions: {
              assumptions: [
                {
                  statement: "Standard invoice formats cover 90% of volume",
                  validation_method: "Invoice sample analysis",
                },
                {
                  statement: "ERP has API access",
                  validation_method: "Technical documentation review",
                },
                {
                  statement: "Users have smartphone cameras",
                  validation_method: "Device inventory check",
                },
              ],
              risks: [
                {
                  description: "OCR accuracy for edge cases",
                  probability: "medium",
                  impact: "high",
                  mitigation: "Manual review fallback",
                },
                {
                  description: "Change management challenges",
                  probability: "high",
                  impact: "medium",
                  mitigation: "Training program",
                },
                {
                  description: "Integration complexity",
                  probability: "medium",
                  impact: "high",
                  mitigation: "Phased rollout",
                },
              ],
            },
            output: {
              prd_delivered: "yes",
              sections_count: 10,
              open_questions: ["ML model training data source", "ERP API availability"],
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
