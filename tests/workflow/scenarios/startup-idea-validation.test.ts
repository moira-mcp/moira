/**
 * startup-idea-validation Scenario Tests
 *
 * Automated startup idea validation: intake -> research -> competitor analysis ->
 * tech assessment -> budget -> team -> risks -> alternatives -> final review -> HTML report.
 * Coverage target: 100% nodes (52), 100% branches (13 conditions x 2)
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
  return findSystemCatalogEntry("startup-idea-validation", "public")!.graph as WorkflowGraph;
}

// --- Reusable data builders ---

function comp(name: string) {
  return {
    name,
    key_features: ["F1", "F2"],
    strengths: ["Strong brand"],
    weaknesses: ["High price"],
  };
}
function fiveComp(names: string[]) {
  return names.map(comp);
}
function risk(cat: string, desc: string, p: number, i: number) {
  return {
    category: cat,
    description: desc,
    probability: p,
    impact: i,
    risk_score: p * i,
    mitigation_strategy: `Mitigate ${desc}`,
  };
}
function fiveRisks() {
  return [
    risk("market", "Competition", 3, 2),
    risk("technical", "Scaling", 2, 3),
    risk("financial", "Funding gap", 2, 2),
    risk("team", "Key person", 2, 2),
    risk("operational", "Vendor lock-in", 1, 3),
  ];
}
function member(role: string, level: string, emp: string, cost: string) {
  return { role, level, employment: emp, monthly_cost: cost };
}
function bud(total: string, timeline: string, scope: string[]) {
  return {
    total,
    timeline,
    scope,
    breakdown: { development: "60%", design: "15%", infrastructure: "10%", marketing: "15%" },
  };
}
function svc(name: string, purpose: string, cost: string) {
  return { service: name, purpose, estimated_cost: cost };
}

const COMP_A = ["Asana", "Monday", "Linear", "ClickUp", "Notion"];
const COMP_B = ["ShopGPT", "Rufus", "Klarna AI", "Mercari", "Whatnot"];
const COMP_C = ["MyChart", "HealthTap", "Medisafe", "CareZone", "PatientPop"];
const COMP_D = ["Coursera", "EdX", "Udemy", "Skillshare", "Codecademy"];

// --- Risk sets for different scenarios ---
const RISKS_C = [
  risk("operational", "HIPAA violation", 2, 3),
  risk("technical", "Data breach", 2, 3),
  risk("operational", "Regulation changes", 2, 2),
  risk("market", "Hospital adoption", 3, 2),
  risk("market", "Patient trust", 2, 2),
];
const RISKS_D = [
  risk("technical", "Scaling", 3, 2),
  risk("technical", "Latency", 2, 3),
  risk("market", "Content quality", 2, 2),
  risk("market", "University adoption", 3, 2),
  risk("operational", "Student retention", 2, 2),
];

describe("startup-idea-validation Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "startup-idea-validation"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected cycles", () => {
      const cycles = detectCycles(workflow);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(52);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        // ================================================================
        // SCENARIO 1: Happy path - everything clean
        // ================================================================
        {
          name: "Happy path - all sections clean",
          description: "All analyses pass, final review confident, direct to HTML",
          mockInputs: {
            intake: {
              product_name: "TaskFlow",
              product_description: "AI task manager",
              problem_statement: "Teams waste time on tasks",
              target_audience: "Remote teams",
              key_features: ["AI prioritization", "Auto-scheduling", "Slack integration"],
              unique_value_proposition: "AI-first task management",
              geography: "Global",
              business_model: "SaaS $15/user/mo",
              product_type: "saas",
              tier1_problem_score: 8,
              red_flags: [],
              assumptions_made: ["Teams prefer integrated tools"],
            },
            "setup-workspace": {
              workspace_path: "/tmp/taskflow",
              idea_file_saved: true,
              verification: "Created",
            },
            "market-research": {
              tam: { value: "$5B", source: "Gartner 2024", year: 2024 },
              sam: { value: "$800M", source: "Internal", calculation_basis: "30% TAM English" },
              som: { value: "$40M", timeframe: "3 years", assumptions: "1-5% capture" },
              market_growth: { cagr: "12%", trend: "growing", source: "Statista 2024" },
              key_trends: ["AI adoption", "Remote work growth", "Automation demand"],
              regulatory_requirements: [],
              market_validation_signals: ["Asana valued $5B"],
            },
            "save-market-report": { market_report_saved: true, verification: "Saved" },
            "competitor-analysis": {
              direct_competitors: fiveComp(COMP_A),
              indirect_competitors: [{ name: "Trello", alternative_approach: "Simple boards" }],
              comparison_table_markdown:
                "| Feature | Asana | Monday | Linear | ClickUp | Notion |\n|---------|-------|--------|--------|---------|--------|",
              market_gaps: ["AI-native prioritization"],
              competitive_advantages: ["AI-first approach"],
              competitors_count: 5,
            },
            "verify-competitors": { issues_count: 0, competitors_verified: 5 },
            "save-competitors-report": { competitors_report_saved: true, verification: "Saved" },
            "tech-assessment": {
              architecture: {
                frontend: "React",
                backend: "Node.js",
                database: "PostgreSQL",
                infrastructure: "AWS",
                integrations: ["Slack API"],
              },
              recommended_stack: {
                frontend_tech: "React 18",
                backend_tech: "Node.js 20",
                database_tech: "PostgreSQL 16",
                hosting: "AWS",
              },
              complexity_score: 6,
              complexity_factors: ["AI integration", "Real-time sync"],
              technical_risks: [
                { risk: "AI accuracy", severity: "medium" as const, mitigation: "A/B testing" },
                { risk: "Scaling", severity: "low" as const, mitigation: "Redis" },
              ],
              third_party_services: [
                svc("AWS", "Hosting", "$500/mo"),
                svc("SendGrid", "Email", "$20/mo"),
              ],
            },
            "save-tech-report": { tech_report_saved: true, verification: "Saved" },
            "budget-estimation": {
              mvp_budget: bud("$80K", "3 months", ["Auth", "Tasks", "AI"]),
              full_budget: bud("$350K", "12 months", ["Full platform", "Integrations"]),
              budget_assumptions: ["$50/hr dev rate", "3-month MVP timeline"],
              monthly_runway: {
                burn_rate: "$25K",
                runway_mvp: "3 months",
                runway_full: "14 months",
              },
              cost_optimization_suggestions: ["Use open-source AI models"],
            },
            "review-budget": { issues_count: 0 },
            "save-budget-report": { budget_report_saved: true, verification: "Saved" },
            "team-requirements": {
              mvp_team: [
                member("Full-stack", "senior", "full-time", "$8K"),
                member("Designer", "middle", "freelance", "$4K"),
              ],
              full_team: [
                member("Backend", "senior", "full-time", "$8K"),
                member("Frontend", "middle", "full-time", "$6K"),
                member("ML", "senior", "full-time", "$10K"),
              ],
              monthly_payroll: { mvp: "$15K", full: "$45K" },
              key_competencies: { must_have: ["Node.js", "React"], nice_to_have: ["K8s"] },
              hiring_recommendations: ["Hire ML engineer first"],
            },
            "save-team-report": { team_report_saved: true, verification: "Saved" },
            "risk-analysis": {
              risks: fiveRisks(),
              high_priority_risks: ["Competition", "Scaling"],
              overall_risk_level: "medium" as const,
              risk_summary: "Manageable risks",
            },
            "review-risks": { issues_count: 0 },
            "save-risks-report": { risks_report_saved: true, verification: "Saved" },
            "alternatives-analysis": {
              alternative_business_models: [
                {
                  model: "Freemium",
                  description: "Free tier",
                  pros: ["Growth"],
                  cons: ["Low conv"],
                  fit_score: 7,
                },
                {
                  model: "Enterprise",
                  description: "Licensing",
                  pros: ["Revenue"],
                  cons: ["Long sales"],
                  fit_score: 5,
                },
              ],
              pivot_options: [
                { pivot_type: "Vertical", description: "Narrow focus", trigger: "Low adoption" },
              ],
              gtm_strategies: [{ strategy: "PLG", description: "Product-led", recommended: true }],
              recommended_approach: "SaaS with enterprise tier",
              exit_strategies: [{ type: "Acquisition", timeline: "2-3 years" }],
            },
            "save-alternatives-report": { alternatives_report_saved: true, verification: "Saved" },
            "final-review": {
              overall_confidence: 8,
              blocking_issues: [] as string[],
              blocking_issues_count: 0,
              go_no_go_recommendation: "strong_go" as const,
              executive_summary: "Validated market need",
              section_scores: { market: 8, tech: 7, budget: 8, team: 7, risks: 7 },
              recommendations: ["Start with MVP"],
            },
            "generate-html": {
              html_file_path: "/tmp/taskflow/report.html",
              verification: "Generated",
            },
            "publish-artifact": {
              artifact_uuid: "uuid-1",
              artifact_url: "https://static.example.com/uuid-1.html",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "intake",
              "check-intake-error",
              "setup-workspace",
              "market-research",
              "verify-competitors",
              "check-competitors-count",
              "save-competitors-report",
              "review-budget",
              "check-budget-review",
              "review-risks",
              "check-risks-review",
              "final-review",
              "check-final-review",
              "generate-html",
              "publish-artifact",
              "notify-complete",
              "end",
            ],
            avoids: [
              "end-error",
              "fix-competitors",
              "refine-budget",
              "refine-risks",
              "enhance-analysis",
              "generate-html-with-warnings",
            ],
          },
        },

        // ================================================================
        // SCENARIO 2: Intake error
        // ================================================================
        {
          name: "Intake error - product name is ERROR",
          description: "Intake produces ERROR product_name, exits to end-error",
          mockInputs: {
            intake: {
              product_name: "ERROR",
              product_description: "Invalid input detected",
              problem_statement: "N/A",
              target_audience: "N/A",
              key_features: ["N/A", "N/A", "N/A"],
              unique_value_proposition: "N/A",
              geography: "N/A",
              business_model: "N/A",
              product_type: "other" as const,
              tier1_problem_score: 1,
              red_flags: ["No valid idea"],
              assumptions_made: [],
            },
          },
          expect: {
            status: "completed",
            reaches: ["intake", "check-intake-error", "end-error"],
            avoids: ["setup-workspace", "market-research", "end"],
          },
        },

        // ================================================================
        // SCENARIO 3: Fix within limits - 1 fix/refine/enhance iteration
        // ================================================================
        {
          name: "Fix within limits - single fix/refine/enhance iteration",
          description:
            "Competitors fixed once, budget refined once, enhance once, all within limit",
          mockInputs: {
            intake: {
              product_name: "ShopBot",
              product_description: "AI shopping assistant",
              problem_statement: "Hard to find products",
              target_audience: "E-commerce shoppers",
              key_features: ["Recs", "Price compare", "Style AI"],
              unique_value_proposition: "AI style understanding",
              geography: "US+EU",
              business_model: "Affiliate + premium",
              product_type: "web_app" as const,
              tier1_problem_score: 6,
              red_flags: [],
              assumptions_made: ["Users trust AI recs"],
            },
            "setup-workspace": {
              workspace_path: "/tmp/shopbot",
              idea_file_saved: true,
              verification: "Created",
            },
            "market-research": {
              tam: { value: "$12B", source: "eMarketer 2024", year: 2024 },
              sam: { value: "$2B", source: "Internal", calculation_basis: "US+EU ecommerce" },
              som: { value: "$50M", timeframe: "3 years", assumptions: "2.5% SAM" },
              market_growth: { cagr: "18%", trend: "growing", source: "Statista" },
              key_trends: ["Conversational commerce", "Visual search", "Social shopping"],
              regulatory_requirements: [],
              market_validation_signals: ["Growing AI spend"],
            },
            "save-market-report": { market_report_saved: true, verification: "Saved" },
            "competitor-analysis": {
              direct_competitors: fiveComp(COMP_B),
              indirect_competitors: [
                { name: "Google Shopping", alternative_approach: "Search-based" },
              ],
              comparison_table_markdown: "| Feature |",
              market_gaps: ["Style-aware recs"],
              competitive_advantages: ["Style AI"],
              competitors_count: 5,
            },
            "verify-competitors": [
              {
                issues_count: 2,
                issues: ["Missing revenue data", "Outdated info"],
                competitors_verified: 5,
              },
              { issues_count: 0, competitors_verified: 5 },
            ],
            "fix-competitors": {
              direct_competitors: fiveComp(COMP_B),
              indirect_competitors: [{ name: "Google Shopping", alternative_approach: "Search" }],
              comparison_table_markdown: "| Updated |",
              competitors_count: 5,
              fixes_applied: ["Added revenue data"],
              fix_competitors_iteration: 1,
            },
            "save-competitors-report": { competitors_report_saved: true, verification: "Saved" },
            "tech-assessment": {
              architecture: {
                frontend: "Next.js",
                backend: "Python FastAPI",
                database: "PostgreSQL",
                infrastructure: "AWS Lambda",
                integrations: ["OpenAI API"],
              },
              recommended_stack: {
                frontend_tech: "Next.js 14",
                backend_tech: "Python 3.12",
                database_tech: "PostgreSQL 16",
                hosting: "AWS",
              },
              complexity_score: 7,
              complexity_factors: ["NLP", "Multi-store API"],
              technical_risks: [
                { risk: "API limits", severity: "medium" as const, mitigation: "Caching" },
                { risk: "Latency", severity: "high" as const, mitigation: "Edge" },
              ],
              third_party_services: [
                svc("AWS Lambda", "Compute", "$200/mo"),
                svc("OpenAI", "AI", "$2K/mo"),
              ],
            },
            "save-tech-report": { tech_report_saved: true, verification: "Saved" },
            "budget-estimation": {
              mvp_budget: bud("$120K", "4 months", ["Chat", "Search", "AI"]),
              full_budget: bud("$500K", "12 months", ["Full platform", "Mobile"]),
              budget_assumptions: ["AI $2K/mo", "4-month MVP"],
              monthly_runway: {
                burn_rate: "$30K",
                runway_mvp: "4 months",
                runway_full: "17 months",
              },
              cost_optimization_suggestions: ["Negotiate API pricing"],
            },
            "review-budget": [
              {
                issues_count: 1,
                issues: ["Missing marketing budget"],
                recommendations: ["Add marketing line item"],
              },
              { issues_count: 0 },
            ],
            "refine-budget": {
              mvp_budget: bud("$140K", "4 months", ["Chat", "Marketing"]),
              full_budget: bud("$550K", "12 months", ["Full", "Marketing"]),
              changes_made: ["Added marketing budget"],
              refine_budget_iteration: 1,
              budget_assumptions: ["Updated with marketing costs"],
            },
            "save-budget-report": { budget_report_saved: true, verification: "Saved" },
            "team-requirements": {
              mvp_team: [
                member("ML engineer", "senior", "full-time", "$10K"),
                member("Full-stack", "middle", "full-time", "$6K"),
              ],
              full_team: [
                member("ML engineer", "senior", "full-time", "$10K"),
                member("Backend", "middle", "full-time", "$6K"),
                member("Frontend", "middle", "full-time", "$6K"),
              ],
              monthly_payroll: { mvp: "$20K", full: "$55K" },
              key_competencies: { must_have: ["Python", "NLP"], nice_to_have: ["AWS"] },
              hiring_recommendations: ["Find NLP specialist"],
            },
            "save-team-report": { team_report_saved: true, verification: "Saved" },
            "risk-analysis": {
              risks: fiveRisks(),
              high_priority_risks: ["Competition", "Scaling"],
              overall_risk_level: "medium" as const,
              risk_summary: "Manageable",
            },
            "review-risks": { issues_count: 0 },
            "save-risks-report": { risks_report_saved: true, verification: "Saved" },
            "alternatives-analysis": {
              alternative_business_models: [
                {
                  model: "White-label",
                  description: "For retailers",
                  pros: ["B2B"],
                  cons: ["Custom"],
                  fit_score: 6,
                },
                {
                  model: "Data",
                  description: "Insights",
                  pros: ["Passive"],
                  cons: ["Privacy"],
                  fit_score: 4,
                },
              ],
              pivot_options: [
                { pivot_type: "Vertical", description: "Fashion niche", trigger: "Low adoption" },
              ],
              gtm_strategies: [{ strategy: "PLG", description: "Product-led", recommended: true }],
              recommended_approach: "Fashion first, expand later",
              exit_strategies: [{ type: "Acquisition", timeline: "2-3 years" }],
            },
            "save-alternatives-report": { alternatives_report_saved: true, verification: "Saved" },
            "final-review": [
              {
                overall_confidence: 5,
                blocking_issues: ["Incomplete moat"],
                blocking_issues_count: 1,
                go_no_go_recommendation: "needs_more_research" as const,
                executive_summary: "Needs moat analysis",
                section_scores: { market: 6, tech: 5, budget: 5, team: 6, risks: 5 },
                recommendations: ["Deepen moat analysis"],
              },
              {
                overall_confidence: 8,
                blocking_issues: [] as string[],
                blocking_issues_count: 0,
                go_no_go_recommendation: "go_with_conditions" as const,
                executive_summary: "Viable with AI diff",
                section_scores: { market: 8, tech: 7, budget: 7, team: 7, risks: 7 },
                recommendations: ["Start MVP"],
              },
            ],
            "enhance-analysis": {
              changes_made: ["Deepened moat analysis"],
              files_updated: ["competitors-report.md"],
              enhance_iteration: 1,
            },
            "generate-html": {
              html_file_path: "/tmp/shopbot/report.html",
              verification: "Generated",
            },
            "publish-artifact": {
              artifact_uuid: "uuid-2",
              artifact_url: "https://static.example.com/uuid-2.html",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "check-competitors-count",
              "check-fix-competitors-limit",
              "fix-competitors",
              "check-budget-review",
              "check-refine-budget-limit",
              "refine-budget",
              "check-final-review",
              "check-iteration-limit",
              "enhance-analysis",
              "generate-html",
            ],
            avoids: [
              "end-error",
              "refine-risks",
              "generate-html-with-warnings",
              "ask-user-competitors-fix-limit-reached",
              "ask-user-budget-fix-limit-reached",
            ],
          },
        },

        // ================================================================
        // SCENARIO 4: All limits reached - competitors/budget continue,
        //              risks reset, enhance continue -> html-with-warnings
        // ================================================================
        {
          name: "All limits - competitors/budget continue, risks reset, enhance continue",
          description:
            "All fix loops exhaust 3 iterations. Competitors/budget/enhance continue, risks reset.",
          mockInputs: {
            intake: {
              product_name: "MedTrack",
              product_description: "Patient health tracking",
              problem_statement: "Patients forget meds",
              target_audience: "Chronic patients",
              key_features: ["Reminders", "Doctor portal", "Health diary"],
              unique_value_proposition: "Patient-doctor communication",
              geography: "US",
              business_model: "B2B2C hospitals",
              product_type: "mobile_app" as const,
              tier1_problem_score: 9,
              red_flags: ["HIPAA complexity"],
              assumptions_made: ["Hospital IT integrates"],
            },
            "setup-workspace": {
              workspace_path: "/tmp/medtrack",
              idea_file_saved: true,
              verification: "Created",
            },
            "market-research": {
              tam: { value: "$20B", source: "Grand View", year: 2024 },
              sam: {
                value: "$3B",
                source: "US digital health",
                calculation_basis: "US chronic care",
              },
              som: { value: "$80M", timeframe: "5 years", assumptions: "2.5% SAM" },
              market_growth: { cagr: "15%", trend: "growing", source: "McKinsey" },
              key_trends: ["Digital health adoption", "Telehealth growth", "Patient engagement"],
              regulatory_requirements: ["HIPAA", "FDA 510(k)"],
              market_validation_signals: ["Teladoc $2B"],
            },
            "save-market-report": { market_report_saved: true, verification: "Saved" },
            "competitor-analysis": {
              direct_competitors: fiveComp(COMP_C),
              indirect_competitors: [
                { name: "Apple Health", alternative_approach: "Device tracking" },
              ],
              comparison_table_markdown: "| Feature |",
              market_gaps: ["Unified patient platform"],
              competitive_advantages: ["Hospital integration"],
              competitors_count: 5,
            },
            // verify-competitors: 4x all with issues -> limit reached
            "verify-competitors": [
              {
                issues_count: 1,
                issues: ["Missing pricing"],
                competitors_verified: 5,
              },
              {
                issues_count: 1,
                issues: ["Outdated market share"],
                competitors_verified: 5,
              },
              {
                issues_count: 1,
                issues: ["Missing integrations"],
                competitors_verified: 5,
              },
              {
                issues_count: 1,
                issues: ["Incomplete features"],
                competitors_verified: 5,
              },
            ],
            // fix-competitors: 3x
            "fix-competitors": [
              {
                direct_competitors: fiveComp(COMP_C),
                indirect_competitors: [{ name: "Apple Health", alternative_approach: "Device" }],
                comparison_table_markdown: "| V1 |",
                competitors_count: 5,
                fixes_applied: ["Added pricing"],
                fix_competitors_iteration: 1,
              },
              {
                direct_competitors: fiveComp(COMP_C),
                indirect_competitors: [{ name: "Apple Health", alternative_approach: "Device" }],
                comparison_table_markdown: "| V2 |",
                competitors_count: 5,
                fixes_applied: ["Updated shares"],
                fix_competitors_iteration: 2,
              },
              {
                direct_competitors: fiveComp(COMP_C),
                indirect_competitors: [{ name: "Apple Health", alternative_approach: "Device" }],
                comparison_table_markdown: "| V3 |",
                competitors_count: 5,
                fixes_applied: ["Added integrations"],
                fix_competitors_iteration: 3,
              },
            ],
            "ask-user-competitors-fix-limit-reached": { decision: "continue" as const },
            "save-competitors-report": { competitors_report_saved: true, verification: "Saved" },
            "tech-assessment": {
              architecture: {
                frontend: "React Native",
                backend: "Java Spring",
                database: "PostgreSQL",
                infrastructure: "AWS GovCloud",
                integrations: ["HL7 FHIR"],
              },
              recommended_stack: {
                frontend_tech: "React Native",
                backend_tech: "Java 21",
                database_tech: "PostgreSQL 16",
                hosting: "AWS GovCloud",
              },
              complexity_score: 8,
              complexity_factors: ["HIPAA", "HL7 integration", "Encryption"],
              technical_risks: [
                { risk: "HIPAA cert", severity: "high" as const, mitigation: "Compliance expert" },
                { risk: "Integration", severity: "medium" as const, mitigation: "FHIR" },
              ],
              third_party_services: [
                svc("AWS GovCloud", "HIPAA hosting", "$2K/mo"),
                svc("Twilio", "SMS", "$100/mo"),
              ],
            },
            "save-tech-report": { tech_report_saved: true, verification: "Saved" },
            "budget-estimation": {
              mvp_budget: bud("$200K", "6 months", ["Core", "Portal", "HIPAA"]),
              full_budget: bud("$800K", "18 months", ["Full platform", "Compliance"]),
              budget_assumptions: ["HIPAA adds 40%", "6-month MVP"],
              monthly_runway: {
                burn_rate: "$45K",
                runway_mvp: "6 months",
                runway_full: "18 months",
              },
              cost_optimization_suggestions: ["Use HIPAA-certified PaaS"],
            },
            // review-budget: 4x all with issues -> limit reached
            "review-budget": [
              {
                issues_count: 1,
                issues: ["Missing compliance costs"],
                recommendations: ["Add HIPAA audit"],
              },
              {
                issues_count: 1,
                issues: ["Underestimated hosting"],
                recommendations: ["Increase hosting"],
              },
              {
                issues_count: 1,
                issues: ["No contingency"],
                recommendations: ["Add 20% buffer"],
              },
              {
                issues_count: 1,
                issues: ["Missing training"],
                recommendations: ["Add training costs"],
              },
            ],
            // refine-budget: 3x
            "refine-budget": [
              {
                mvp_budget: bud("$220K", "6 months", ["Core", "V1"]),
                full_budget: bud("$850K", "18 months", ["Full", "V1"]),
                changes_made: ["Added compliance"],
                refine_budget_iteration: 1,
                budget_assumptions: ["Updated HIPAA costs"],
              },
              {
                mvp_budget: bud("$240K", "6 months", ["Core", "V2"]),
                full_budget: bud("$900K", "18 months", ["Full", "V2"]),
                changes_made: ["Increased hosting"],
                refine_budget_iteration: 2,
                budget_assumptions: ["Updated hosting"],
              },
              {
                mvp_budget: bud("$260K", "6 months", ["Core", "V3"]),
                full_budget: bud("$950K", "18 months", ["Full", "V3"]),
                changes_made: ["Added contingency"],
                refine_budget_iteration: 3,
                budget_assumptions: ["Added buffer"],
              },
            ],
            "ask-user-budget-fix-limit-reached": { decision: "continue" as const },
            "save-budget-report": { budget_report_saved: true, verification: "Saved" },
            "team-requirements": {
              mvp_team: [
                member("Backend", "senior", "full-time", "$9K"),
                member("Mobile", "senior", "full-time", "$9K"),
                member("Compliance", "senior", "full-time", "$8K"),
              ],
              full_team: [
                member("Backend", "senior", "full-time", "$9K"),
                member("Mobile", "senior", "full-time", "$9K"),
                member("QA", "middle", "full-time", "$5K"),
              ],
              monthly_payroll: { mvp: "$30K", full: "$70K" },
              key_competencies: { must_have: ["Java", "HIPAA"], nice_to_have: ["HL7"] },
              hiring_recommendations: ["Compliance officer critical"],
            },
            "save-team-report": { team_report_saved: true, verification: "Saved" },
            "risk-analysis": {
              risks: RISKS_C,
              high_priority_risks: ["HIPAA violation", "Data breach"],
              overall_risk_level: "high" as const,
              risk_summary: "High regulatory risk",
            },
            // review-risks: 5x (4 issues + 1 clean after reset)
            "review-risks": [
              {
                issues_count: 1,
                issues: ["Missing HIPAA detail"],
                missed_risks: [],
              },
              {
                issues_count: 1,
                issues: ["Breach response incomplete"],
                missed_risks: [],
              },
              {
                issues_count: 1,
                issues: ["No insurance"],
                missed_risks: [],
              },
              {
                issues_count: 1,
                issues: ["Vendor risk"],
                missed_risks: [],
              },
              { issues_count: 0 },
            ],
            // refine-risks: 4x (3 before limit + 1 after reset)
            "refine-risks": [
              {
                risks: RISKS_C,
                high_priority_risks: ["HIPAA violation"],
                overall_risk_level: "high" as const,
                changes_made: ["Detailed HIPAA"],
                refine_risks_iteration: 1,
                risk_summary: "Updated HIPAA",
              },
              {
                risks: RISKS_C,
                high_priority_risks: ["HIPAA violation"],
                overall_risk_level: "high" as const,
                changes_made: ["Added response"],
                refine_risks_iteration: 2,
                risk_summary: "Added breach response",
              },
              {
                risks: RISKS_C,
                high_priority_risks: ["HIPAA violation"],
                overall_risk_level: "high" as const,
                changes_made: ["Added insurance"],
                refine_risks_iteration: 3,
                risk_summary: "Added insurance",
              },
              {
                risks: RISKS_C,
                high_priority_risks: ["HIPAA violation"],
                overall_risk_level: "medium" as const,
                changes_made: ["Final risk update"],
                refine_risks_iteration: 1,
                risk_summary: "Comprehensive risk plan",
              },
            ],
            "ask-user-risks-fix-limit-reached": { decision: "reset" as const },
            "save-risks-report": { risks_report_saved: true, verification: "Saved" },
            "alternatives-analysis": {
              alternative_business_models: [
                {
                  model: "D2C",
                  description: "Direct",
                  pros: ["Control"],
                  cons: ["Marketing"],
                  fit_score: 4,
                },
                {
                  model: "Insurance",
                  description: "Partnerships",
                  pros: ["Revenue"],
                  cons: ["Long cycle"],
                  fit_score: 6,
                },
              ],
              pivot_options: [
                { pivot_type: "Vertical", description: "Diabetes focus", trigger: "Low adoption" },
              ],
              gtm_strategies: [
                { strategy: "B2B2C", description: "Through hospitals", recommended: true },
              ],
              recommended_approach: "B2B2C through hospitals",
              exit_strategies: [{ type: "Acquisition", timeline: "2-3 years" }],
            },
            "save-alternatives-report": { alternatives_report_saved: true, verification: "Saved" },
            // final-review: 4x all fail -> enhance limit -> continue -> html-with-warnings
            "final-review": [
              {
                overall_confidence: 4,
                blocking_issues: ["Regulatory gaps"],
                blocking_issues_count: 1,
                go_no_go_recommendation: "needs_more_research" as const,
                executive_summary: "Regulatory gaps",
                section_scores: { market: 6, tech: 5, budget: 4, team: 6, risks: 4 },
                recommendations: ["Address HIPAA"],
              },
              {
                overall_confidence: 5,
                blocking_issues: ["Budget uncertainty"],
                blocking_issues_count: 1,
                go_no_go_recommendation: "needs_more_research" as const,
                executive_summary: "Budget uncertain",
                section_scores: { market: 6, tech: 5, budget: 5, team: 6, risks: 5 },
                recommendations: ["Validate budget"],
              },
              {
                overall_confidence: 6,
                blocking_issues: ["Team timeline"],
                blocking_issues_count: 1,
                go_no_go_recommendation: "go_with_conditions" as const,
                executive_summary: "Team gaps",
                section_scores: { market: 7, tech: 6, budget: 5, team: 5, risks: 5 },
                recommendations: ["Hire faster"],
              },
              {
                overall_confidence: 6,
                blocking_issues: ["Persistent issues"],
                blocking_issues_count: 1,
                go_no_go_recommendation: "go_with_conditions" as const,
                executive_summary: "Max enhancement reached",
                section_scores: { market: 7, tech: 6, budget: 6, team: 6, risks: 5 },
                recommendations: ["Accept risk"],
              },
            ],
            // enhance-analysis: 3x
            "enhance-analysis": [
              {
                changes_made: ["HIPAA deep-dive"],
                files_updated: ["risks-report.md"],
                enhance_iteration: 1,
              },
              {
                changes_made: ["Budget validation"],
                files_updated: ["budget-report.md"],
                enhance_iteration: 2,
              },
              {
                changes_made: ["Team planning"],
                files_updated: ["team-report.md"],
                enhance_iteration: 3,
              },
            ],
            "ask-user-enhance-fix-limit-reached": { decision: "continue" as const },
            "generate-html-with-warnings": {
              html_file_path: "/tmp/medtrack/report.html",
              verification: "With warnings",
              has_warnings: true,
            },
            "publish-artifact": {
              artifact_uuid: "uuid-3",
              artifact_url: "https://static.example.com/uuid-3.html",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "check-fix-competitors-limit",
              "ask-user-competitors-fix-limit-reached",
              "route-competitors-fix-limit-decision",
              "check-refine-budget-limit",
              "ask-user-budget-fix-limit-reached",
              "route-budget-fix-limit-decision",
              "check-refine-risks-limit",
              "ask-user-risks-fix-limit-reached",
              "route-risks-fix-limit-decision",
              "expr-reset-risks-fix-counter",
              "check-iteration-limit",
              "ask-user-enhance-fix-limit-reached",
              "route-enhance-fix-limit-decision",
              "generate-html-with-warnings",
            ],
            avoids: [
              "end-error",
              "generate-html",
              "expr-reset-competitors-fix-counter",
              "expr-reset-budget-fix-counter",
              "expr-reset-enhance-fix-counter",
            ],
          },
        },

        // ================================================================
        // SCENARIO 5: All limits reached - competitors/budget/enhance reset,
        //              risks continue (opposite of scenario 4)
        // ================================================================
        {
          name: "All limits - competitors/budget/enhance reset, risks continue",
          description: "All fix loops exhaust iterations, opposite decisions from scenario 4",
          mockInputs: {
            intake: {
              product_name: "EduStream",
              product_description: "Live learning platform",
              problem_statement: "Lacks real-time interaction",
              target_audience: "University students",
              key_features: ["Live coding", "Quizzes", "Peer review"],
              unique_value_proposition: "Real-time collaborative learning",
              geography: "North America",
              business_model: "University licensing",
              product_type: "web_app" as const,
              tier1_problem_score: 7,
              red_flags: [],
              assumptions_made: ["Universities have budget"],
            },
            "setup-workspace": {
              workspace_path: "/tmp/edustream",
              idea_file_saved: true,
              verification: "Created",
            },
            "market-research": {
              tam: { value: "$8B", source: "HolonIQ 2024", year: 2024 },
              sam: { value: "$1.5B", source: "NA EdTech", calculation_basis: "NA universities" },
              som: { value: "$30M", timeframe: "3 years", assumptions: "2% SAM" },
              market_growth: { cagr: "20%", trend: "growing", source: "HolonIQ" },
              key_trends: ["EdTech growth", "Remote learning", "Interactive content"],
              regulatory_requirements: [],
              market_validation_signals: ["Coursera IPO"],
            },
            "save-market-report": { market_report_saved: true, verification: "Saved" },
            "competitor-analysis": {
              direct_competitors: fiveComp(COMP_D),
              indirect_competitors: [{ name: "YouTube", alternative_approach: "Recorded content" }],
              comparison_table_markdown: "| Feature |",
              market_gaps: ["Real-time collab learning"],
              competitive_advantages: ["Live coding env"],
              competitors_count: 5,
            },
            // verify-competitors: 5x (4 issues + 1 clean after reset)
            "verify-competitors": [
              {
                issues_count: 1,
                issues: ["No pricing"],
                competitors_verified: 5,
              },
              {
                issues_count: 1,
                issues: ["Missing courses count"],
                competitors_verified: 5,
              },
              {
                issues_count: 1,
                issues: ["No user metrics"],
                competitors_verified: 5,
              },
              {
                issues_count: 1,
                issues: ["Incomplete partnerships"],
                competitors_verified: 5,
              },
              { issues_count: 0, competitors_verified: 5 },
            ],
            // fix-competitors: 4x (3 before + 1 after reset)
            "fix-competitors": [
              {
                direct_competitors: fiveComp(COMP_D),
                indirect_competitors: [{ name: "YouTube", alternative_approach: "Recorded" }],
                comparison_table_markdown: "| V1 |",
                competitors_count: 5,
                fixes_applied: ["Added pricing"],
                fix_competitors_iteration: 1,
              },
              {
                direct_competitors: fiveComp(COMP_D),
                indirect_competitors: [{ name: "YouTube", alternative_approach: "Recorded" }],
                comparison_table_markdown: "| V2 |",
                competitors_count: 5,
                fixes_applied: ["Added courses"],
                fix_competitors_iteration: 2,
              },
              {
                direct_competitors: fiveComp(COMP_D),
                indirect_competitors: [{ name: "YouTube", alternative_approach: "Recorded" }],
                comparison_table_markdown: "| V3 |",
                competitors_count: 5,
                fixes_applied: ["Added metrics"],
                fix_competitors_iteration: 3,
              },
              {
                direct_competitors: fiveComp(COMP_D),
                indirect_competitors: [{ name: "YouTube", alternative_approach: "Recorded" }],
                comparison_table_markdown: "| V4 |",
                competitors_count: 5,
                fixes_applied: ["Final fix"],
                fix_competitors_iteration: 1,
              },
            ],
            "ask-user-competitors-fix-limit-reached": { decision: "reset" as const },
            "save-competitors-report": { competitors_report_saved: true, verification: "Saved" },
            "tech-assessment": {
              architecture: {
                frontend: "React",
                backend: "Elixir Phoenix",
                database: "PostgreSQL",
                infrastructure: "AWS",
                integrations: ["WebSocket", "Mux"],
              },
              recommended_stack: {
                frontend_tech: "React 18",
                backend_tech: "Elixir 1.16",
                database_tech: "PostgreSQL 16",
                hosting: "AWS",
              },
              complexity_score: 8,
              complexity_factors: ["Real-time", "Sandbox", "Video streaming"],
              technical_risks: [
                { risk: "WebSocket scaling", severity: "high" as const, mitigation: "Clustering" },
                { risk: "Sandbox security", severity: "high" as const, mitigation: "Docker" },
              ],
              third_party_services: [
                svc("AWS", "Hosting", "$500/mo"),
                svc("Mux", "Video", "$300/mo"),
              ],
            },
            "save-tech-report": { tech_report_saved: true, verification: "Saved" },
            "budget-estimation": {
              mvp_budget: bud("$150K", "5 months", ["Live coding", "Quizzes"]),
              full_budget: bud("$600K", "14 months", ["Full platform", "Video"]),
              budget_assumptions: ["WebSocket $3K/mo", "5-month MVP"],
              monthly_runway: {
                burn_rate: "$30K",
                runway_mvp: "5 months",
                runway_full: "20 months",
              },
              cost_optimization_suggestions: ["Fly.io for WebSocket scaling"],
            },
            // review-budget: 5x (4 issues + 1 clean after reset)
            "review-budget": [
              {
                issues_count: 1,
                issues: ["Missing video costs"],
                recommendations: ["Add Mux costs"],
              },
              {
                issues_count: 1,
                issues: ["CDN underbudgeted"],
                recommendations: ["Increase CDN"],
              },
              {
                issues_count: 1,
                issues: ["No scaling plan"],
                recommendations: ["Add scaling costs"],
              },
              {
                issues_count: 1,
                issues: ["Support missing"],
                recommendations: ["Add support costs"],
              },
              { issues_count: 0 },
            ],
            // refine-budget: 4x (3 before + 1 after reset)
            "refine-budget": [
              {
                mvp_budget: bud("$165K", "5 months", ["Core", "V1"]),
                full_budget: bud("$650K", "14 months", ["Full", "V1"]),
                changes_made: ["Added video"],
                refine_budget_iteration: 1,
                budget_assumptions: ["Video costs included"],
              },
              {
                mvp_budget: bud("$180K", "5 months", ["Core", "V2"]),
                full_budget: bud("$700K", "14 months", ["Full", "V2"]),
                changes_made: ["CDN increase"],
                refine_budget_iteration: 2,
                budget_assumptions: ["CDN updated"],
              },
              {
                mvp_budget: bud("$195K", "5 months", ["Core", "V3"]),
                full_budget: bud("$750K", "14 months", ["Full", "V3"]),
                changes_made: ["Scaling plan"],
                refine_budget_iteration: 3,
                budget_assumptions: ["Scaling included"],
              },
              {
                mvp_budget: bud("$210K", "5 months", ["Core", "Final"]),
                full_budget: bud("$780K", "14 months", ["Full", "Final"]),
                changes_made: ["Final fix"],
                refine_budget_iteration: 1,
                budget_assumptions: ["Finalized"],
              },
            ],
            "ask-user-budget-fix-limit-reached": { decision: "reset" as const },
            "save-budget-report": { budget_report_saved: true, verification: "Saved" },
            "team-requirements": {
              mvp_team: [
                member("Backend", "senior", "full-time", "$9K"),
                member("Frontend", "middle", "full-time", "$6K"),
              ],
              full_team: [
                member("Backend", "senior", "full-time", "$9K"),
                member("Frontend", "middle", "full-time", "$6K"),
                member("DevOps", "senior", "full-time", "$8K"),
              ],
              monthly_payroll: { mvp: "$18K", full: "$50K" },
              key_competencies: { must_have: ["Elixir", "React"], nice_to_have: ["Docker"] },
              hiring_recommendations: ["Find Elixir expert"],
            },
            "save-team-report": { team_report_saved: true, verification: "Saved" },
            "risk-analysis": {
              risks: RISKS_D,
              high_priority_risks: ["Scaling", "Latency"],
              overall_risk_level: "medium" as const,
              risk_summary: "Technical risks primary",
            },
            // review-risks: 4x all issues -> limit reached -> continue
            "review-risks": [
              {
                issues_count: 1,
                issues: ["Missing scale metrics"],
                missed_risks: [],
              },
              {
                issues_count: 1,
                issues: ["Latency underestimated"],
                missed_risks: [],
              },
              {
                issues_count: 1,
                issues: ["No fallback plan"],
                missed_risks: [],
              },
              {
                issues_count: 1,
                issues: ["Student load peaks"],
                missed_risks: [],
              },
            ],
            // refine-risks: 3x
            "refine-risks": [
              {
                risks: RISKS_D,
                high_priority_risks: ["Scaling"],
                overall_risk_level: "medium" as const,
                changes_made: ["Added benchmarks"],
                refine_risks_iteration: 1,
                risk_summary: "Scale metrics added",
              },
              {
                risks: RISKS_D,
                high_priority_risks: ["Scaling"],
                overall_risk_level: "medium" as const,
                changes_made: ["P99 measurement"],
                refine_risks_iteration: 2,
                risk_summary: "Latency measured",
              },
              {
                risks: RISKS_D,
                high_priority_risks: ["Scaling"],
                overall_risk_level: "medium" as const,
                changes_made: ["Fallback plan"],
                refine_risks_iteration: 3,
                risk_summary: "Degradation planned",
              },
            ],
            "ask-user-risks-fix-limit-reached": { decision: "continue" as const },
            "save-risks-report": { risks_report_saved: true, verification: "Saved" },
            "alternatives-analysis": {
              alternative_business_models: [
                {
                  model: "Corporate",
                  description: "Training",
                  pros: ["B2B"],
                  cons: ["UX change"],
                  fit_score: 5,
                },
                {
                  model: "K-12",
                  description: "Schools",
                  pros: ["Scale"],
                  cons: ["Procurement"],
                  fit_score: 4,
                },
              ],
              pivot_options: [
                {
                  pivot_type: "Market",
                  description: "K-12 pivot",
                  trigger: "University sales too slow",
                },
              ],
              gtm_strategies: [
                { strategy: "Partnership", description: "University licensing", recommended: true },
              ],
              recommended_approach: "University licensing with freemium",
              exit_strategies: [{ type: "Acquisition", timeline: "2-3 years" }],
            },
            "save-alternatives-report": { alternatives_report_saved: true, verification: "Saved" },
            // final-review: 5x (4 fail + 1 pass after reset)
            "final-review": [
              {
                overall_confidence: 4,
                blocking_issues: ["Scaling incomplete"],
                blocking_issues_count: 1,
                go_no_go_recommendation: "needs_more_research" as const,
                executive_summary: "Need scaling validation",
                section_scores: { market: 6, tech: 5, budget: 5, team: 6, risks: 4 },
                recommendations: ["Validate scaling"],
              },
              {
                overall_confidence: 5,
                blocking_issues: ["Cost uncertain"],
                blocking_issues_count: 1,
                go_no_go_recommendation: "needs_more_research" as const,
                executive_summary: "Cost concerns",
                section_scores: { market: 6, tech: 5, budget: 5, team: 6, risks: 5 },
                recommendations: ["Validate costs"],
              },
              {
                overall_confidence: 6,
                blocking_issues: ["GTM unclear"],
                blocking_issues_count: 1,
                go_no_go_recommendation: "go_with_conditions" as const,
                executive_summary: "GTM needs work",
                section_scores: { market: 7, tech: 6, budget: 6, team: 6, risks: 5 },
                recommendations: ["Define GTM"],
              },
              {
                overall_confidence: 6,
                blocking_issues: ["Partnership vague"],
                blocking_issues_count: 1,
                go_no_go_recommendation: "go_with_conditions" as const,
                executive_summary: "Enhancement limit",
                section_scores: { market: 7, tech: 6, budget: 6, team: 6, risks: 5 },
                recommendations: ["Clarify partnerships"],
              },
              {
                overall_confidence: 8,
                blocking_issues: [] as string[],
                blocking_issues_count: 0,
                go_no_go_recommendation: "go_with_conditions" as const,
                executive_summary: "Viable with partnerships",
                section_scores: { market: 8, tech: 7, budget: 7, team: 7, risks: 7 },
                recommendations: ["Start with partnerships"],
              },
            ],
            // enhance-analysis: 4x (3 before + 1 after reset)
            "enhance-analysis": [
              {
                changes_made: ["Scaling analysis"],
                files_updated: ["tech-report.md"],
                enhance_iteration: 1,
              },
              {
                changes_made: ["Cost validation"],
                files_updated: ["budget-report.md"],
                enhance_iteration: 2,
              },
              {
                changes_made: ["GTM strategy"],
                files_updated: ["alternatives-report.md"],
                enhance_iteration: 3,
              },
              {
                changes_made: ["Partnership details"],
                files_updated: ["alternatives-report.md"],
                enhance_iteration: 1,
              },
            ],
            "ask-user-enhance-fix-limit-reached": { decision: "reset" as const },
            "generate-html": {
              html_file_path: "/tmp/edustream/report.html",
              verification: "Generated",
            },
            "publish-artifact": {
              artifact_uuid: "uuid-4",
              artifact_url: "https://static.example.com/uuid-4.html",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "expr-reset-competitors-fix-counter",
              "route-competitors-fix-limit-decision",
              "expr-reset-budget-fix-counter",
              "route-budget-fix-limit-decision",
              "check-refine-risks-limit",
              "route-risks-fix-limit-decision",
              "expr-reset-enhance-fix-counter",
              "route-enhance-fix-limit-decision",
              "generate-html",
            ],
            avoids: ["end-error", "generate-html-with-warnings", "expr-reset-risks-fix-counter"],
          },
        },
      ];

      const results: ScenarioResult[] = [];
      for (const scenario of scenarios) {
        const result = await runScenario(workflow, scenario);
        results.push(result);
      }

      const failedScenarios = results.filter((r) => !r.passed);
      if (failedScenarios.length > 0) {
        console.error("Failed scenarios:");
        for (const s of failedScenarios) {
          console.error(`  - ${s.scenario}: ${s.error || s.failedExpectations?.join(", ")}`);
        }
      }
      expect(failedScenarios).toHaveLength(0);

      const coverage = calculateCoverage(workflow, results, {
        includeGapAnalysis: true,
      });

      console.log(formatCoverageReport(coverage));

      expect(coverage.nodeCoverage).toBe(100);
      expect(coverage.branchCoverage).toBe(100);
    });
  });
});
