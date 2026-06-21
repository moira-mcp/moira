/**
 * marketing-campaign Scenario Tests
 *
 * Linear marketing campaign creation workflow.
 * Path: product → audience → competitive → positioning → proof → brand → create → review → end
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
  return findSystemCatalogEntry("marketing-campaign", "public")!.graph as WorkflowGraph;
}

describe("marketing-campaign Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "marketing-campaign"}`, ...workflow };
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
        // Scenario 1: Complete marketing campaign
        {
          name: "Complete marketing campaign workflow",
          description: "Full marketing campaign creation",
          expect: { status: "completed" },
          mockInputs: {
            product: {
              product_description: "CloudSync Pro - SaaS cloud sync solution",
              problem_solved: "Data loss, slow sync, high costs",
              usps: ["Real-time sync", "Offline mode", "Team collaboration"],
              competitive_advantage: "$29/month - affordable enterprise features",
            },
            audience: {
              personas: [
                {
                  name: "Small Business Owner",
                  pain_points: ["Data loss anxiety", "Slow sync speeds"],
                  decision_criteria: ["Price", "Ease of use"],
                },
                {
                  name: "Remote Team Lead",
                  pain_points: ["Collaboration difficulties", "Unreliable sync"],
                  decision_criteria: ["Reliability", "Customer support"],
                },
              ],
              primary_persona: "Small business owners aged 25-45",
            },
            competitive: {
              competitors: [
                {
                  name: "Dropbox",
                  positioning: "Simple file sharing for everyone",
                  weaknesses: ["Slow sync", "Expensive for teams"],
                },
                {
                  name: "Google Drive",
                  positioning: "Integrated with Google Workspace",
                  weaknesses: ["Requires Google account", "Limited offline"],
                },
                {
                  name: "OneDrive",
                  positioning: "Microsoft ecosystem integration",
                  weaknesses: ["Complex interface", "Unreliable sync"],
                },
              ],
              market_gaps: ["Speed", "Offline reliability", "Affordable pricing"],
            },
            positioning: {
              positioning_statement: "The fastest cloud sync for busy professionals",
              key_messages: [
                "Never wait for sync again",
                "Work anywhere, anytime",
                "Save 50% on cloud storage costs",
              ],
              value_proposition: "3x faster sync at half the price",
              differentiator: "Fastest offline-first architecture",
            },
            proof: {
              claims: [
                {
                  claim: "99.9% uptime",
                  proof_type: "data",
                  proof_content: "Based on 12-month SLA reports and monitoring data",
                },
                {
                  claim: "3x faster",
                  proof_type: "data",
                  proof_content: "Independent benchmark by TechReview comparing sync speeds",
                },
                {
                  claim: "Acme reduced sync time 80%",
                  proof_type: "case_study",
                  proof_content:
                    "Acme Corp case study showing 80% reduction in sync time after migration",
                },
              ],
            },
            brand: {
              tone: "Professional yet friendly",
              style: "Confident, helpful, action-oriented",
              banned_phrases: ["Best in class", "Revolutionary", "Synergy"],
              examples: ["Use action verbs", "Focus on time savings"],
            },
            create: {
              materials: [
                {
                  type: "headline",
                  content: "Never Wait for Sync Again - CloudSync Pro",
                  proof_used: ["3x faster"],
                },
                {
                  type: "body",
                  content:
                    "Experience lightning-fast cloud sync with offline-first architecture. Save 50% compared to competitors while getting 3x the speed.",
                  proof_used: ["3x faster", "Acme reduced sync time 80%"],
                },
                { type: "cta", content: "Start Your Free Trial Today", proof_used: [] },
              ],
            },
            review: {
              checklist: [
                { item: "Brand voice consistent", passed: true, notes: "Matches brand guidelines" },
                {
                  item: "Claims substantiated",
                  passed: true,
                  notes: "All claims backed by proof points",
                },
                { item: "CTAs clear", passed: true, notes: "Clear call to action" },
                {
                  item: "Target audience addressed",
                  passed: true,
                  notes: "Resonates with small business owners",
                },
                {
                  item: "Differentiation clear",
                  passed: true,
                  notes: "Speed advantage highlighted",
                },
              ],
              approved: true,
              improvements_needed: ["Tighten headline"],
            },
          },
        },

        // Scenario 2: Simple campaign
        {
          name: "Simple marketing campaign",
          description: "Minimal campaign for product launch",
          expect: { status: "completed" },
          mockInputs: {
            product: {
              product_description: "Feature X - Add-on capability",
              problem_solved: "Missing functionality requested by users",
              usps: ["First to market", "Seamless integration"],
            },
            audience: {
              personas: [
                {
                  name: "Existing Customer",
                  pain_points: ["Missing functionality", "Feature requests unfulfilled"],
                  decision_criteria: ["Feature availability", "Integration with existing workflow"],
                },
              ],
              primary_persona: "Existing customers",
            },
            competitive: {
              competitors: [
                {
                  name: "Legacy solution",
                  positioning: "Basic functionality",
                  weaknesses: ["No new features", "Outdated interface"],
                },
              ],
              market_gaps: ["First to market with this specific feature"],
            },
            positioning: {
              positioning_statement: "New capability for existing users",
              key_messages: [
                "Now available for all users",
                "Seamlessly integrated",
                "No additional cost",
              ],
              value_proposition: "Extend your capabilities",
              differentiator: "Only solution with this feature",
            },
            proof: {
              claims: [
                {
                  claim: "Beta user approved",
                  proof_type: "testimonial",
                  proof_content: "Positive feedback from 50 beta users",
                },
                {
                  claim: "Seamless integration",
                  proof_type: "data",
                  proof_content: "Zero integration issues reported in 30-day beta",
                },
                {
                  claim: "Immediate productivity boost",
                  proof_type: "case_study",
                  proof_content: "Beta users reported 25% time savings on average",
                },
              ],
            },
            brand: {
              tone: "Consistent with main product",
              style: "Informative",
              banned_phrases: [],
            },
            create: {
              materials: [
                {
                  type: "headline",
                  content: "New Feature X Now Available",
                  proof_used: ["Beta user approved"],
                },
                {
                  type: "body",
                  content:
                    "Seamlessly integrated into your existing workflow with zero learning curve. Start using Feature X today at no additional cost.",
                  proof_used: ["Seamless integration", "Immediate productivity boost"],
                },
                { type: "cta", content: "Activate Feature X Now", proof_used: [] },
              ],
            },
            review: {
              checklist: [
                { item: "Brand consistent", passed: true },
                { item: "Message clear", passed: true },
                { item: "Claims backed by proof", passed: true },
                { item: "CTA actionable", passed: true },
                { item: "Audience targeted", passed: true },
              ],
              approved: true,
            },
          },
        },

        // Scenario 3: Enterprise B2B campaign
        {
          name: "Enterprise B2B marketing campaign",
          description: "Comprehensive B2B enterprise campaign",
          expect: { status: "completed" },
          mockInputs: {
            product: {
              product_description: "Enterprise Security Suite - Complete cybersecurity platform",
              problem_solved: "Complex security management, compliance burden, fragmented tools",
              usps: [
                "Zero-trust architecture",
                "AI threat detection",
                "Compliance automation",
                "24/7 SOC",
              ],
              competitive_advantage: "Only platform with integrated compliance automation",
            },
            audience: {
              personas: [
                {
                  name: "CISO",
                  pain_points: ["Complex security management", "Compliance burden"],
                  decision_criteria: ["Risk reduction", "Compliance automation"],
                },
                {
                  name: "IT Director",
                  pain_points: ["Fragmented tooling", "Integration overhead"],
                  decision_criteria: ["Integration capabilities", "Reliability"],
                },
                {
                  name: "Compliance Officer",
                  pain_points: ["Audit preparation time", "Manual reporting"],
                  decision_criteria: ["Audit readiness", "Total cost of ownership"],
                },
              ],
              primary_persona:
                "CISOs at 1000+ employee companies in Finance, Healthcare, Government",
            },
            competitive: {
              competitors: [
                {
                  name: "CrowdStrike",
                  positioning: "Cloud-native endpoint protection",
                  weaknesses: ["High price point", "Complex deployment"],
                },
                {
                  name: "Palo Alto",
                  positioning: "Enterprise network security",
                  weaknesses: ["Fragmented product line", "Steep learning curve"],
                },
                {
                  name: "Microsoft",
                  positioning: "Bundled with enterprise licenses",
                  weaknesses: ["Not best-of-breed", "Limited customization"],
                },
              ],
              market_gaps: ["Integrated compliance", "Faster deployment", "Better ROI"],
            },
            positioning: {
              positioning_statement: "Complete security that proves compliance automatically",
              key_messages: [
                "Reduce risk, prove compliance",
                "Unified platform, API-first",
                "Lower TCO, faster ROI",
              ],
              value_proposition: "Reduce compliance audit prep by 90%",
              differentiator: "Only platform with automated compliance proof",
            },
            proof: {
              claims: [
                {
                  claim: "50% reduction in incidents",
                  proof_type: "case_study",
                  proof_content: "Bank of X case study showing 50% reduction in security incidents",
                },
                {
                  claim: "Audit prep: 2 weeks vs 2 months",
                  proof_type: "case_study",
                  proof_content: "Hospital Y reduced audit preparation from 2 months to 2 weeks",
                },
                {
                  claim: "Gartner Leader",
                  proof_type: "data",
                  proof_content: "Named a Leader in Gartner Magic Quadrant 2024",
                },
              ],
            },
            brand: {
              tone: "Authoritative, trustworthy, expert",
              style: "Professional, reassuring, technical",
              banned_phrases: [
                "Fear-based messaging",
                "Unsubstantiated claims",
                "Jargon without explanation",
              ],
              examples: ["Lead with outcomes", "Use specific numbers"],
            },
            create: {
              materials: [
                {
                  type: "headline",
                  content: "Complete Security That Proves Compliance Automatically",
                  proof_used: ["Gartner Leader"],
                },
                {
                  type: "body",
                  content:
                    "Reduce compliance audit prep by 90% with our automated compliance proof platform. Trusted by leading enterprises with 50% reduction in security incidents.",
                  proof_used: ["50% reduction in incidents", "Audit prep: 2 weeks vs 2 months"],
                },
                { type: "cta", content: "Request Enterprise Demo", proof_used: [] },
              ],
            },
            review: {
              checklist: [
                { item: "Legal review passed", passed: true, notes: "Reviewed by legal team" },
                {
                  item: "Compliance review passed",
                  passed: true,
                  notes: "GDPR and SOC2 compliant",
                },
                {
                  item: "Brand voice consistent",
                  passed: true,
                  notes: "Authoritative and trustworthy",
                },
                {
                  item: "Claims substantiated",
                  passed: true,
                  notes: "All claims backed by case studies",
                },
                {
                  item: "Target audience addressed",
                  passed: true,
                  notes: "CISO and IT Directors addressed",
                },
              ],
              approved: true,
              improvements_needed: ["Clarify SLA guarantees", "Add more proof points"],
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
