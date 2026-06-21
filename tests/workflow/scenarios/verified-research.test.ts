/**
 * verified-research Scenario Tests
 *
 * Linear verified-research workflow for investigating topics.
 * Path: question → methodology → gather → read → alternative → synthesize → limitations → output → end
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
  return findSystemCatalogEntry("verified-research", "public")!.graph as WorkflowGraph;
}

describe("verified-research Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "verified-research"}`, ...workflow };
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
        // Scenario 1: Complete verified-research flow
        {
          name: "Complete verified-research workflow",
          description: "Full verified-research from question to final output",
          expect: { status: "completed" },
          mockInputs: {
            question: {
              research_question: "What are best practices for API rate limiting?",
              success_criteria: ["Comprehensive list of patterns with pros/cons"],
              scope_in: ["Production HTTP APIs"],
              scope_out: ["Internal APIs"],
            },
            methodology: {
              source_types: ["academic", "industry", "documentation"],
              keywords: ["rate limiting", "throttling", "API gateway"],
              quality_criteria: ["Peer-reviewed or official docs"],
              time_period: "last 3 years",
            },
            gather: {
              sources: [
                {
                  title: "RFC 6585",
                  url: "https://example.com/rfc",
                  type: "academic",
                  relevance_note: "HTTP status codes",
                },
                {
                  title: "Stripe Rate Limiting",
                  url: "https://stripe.com/docs",
                  type: "industry",
                  relevance_note: "Production patterns",
                },
                {
                  title: "Kong Gateway",
                  url: "https://kong.io/docs",
                  type: "documentation",
                  relevance_note: "API gateway approach",
                },
                {
                  title: "AWS API Gateway",
                  url: "https://aws.amazon.com/docs",
                  type: "documentation",
                  relevance_note: "Cloud patterns",
                },
                {
                  title: "Google Cloud Endpoints",
                  url: "https://cloud.google.com/docs",
                  type: "documentation",
                  relevance_note: "Rate limiting config",
                },
              ],
            },
            read: {
              readings: [
                {
                  source_id: 1,
                  main_finding: "429 status code standard",
                  key_quotes: ["Retry-After header usage"],
                },
                {
                  source_id: 2,
                  main_finding: "Token bucket algorithm",
                  key_quotes: ["Rate limits per API key"],
                },
                {
                  source_id: 3,
                  main_finding: "Plugin-based limiting",
                  key_quotes: ["Request counting strategies"],
                },
              ],
            },
            alternative: {
              alternative_views: [
                {
                  viewpoint: "Server-side vs client-side limiting",
                  source: "Industry article",
                  reasoning: "Client-side reduces server load",
                },
                {
                  viewpoint: "Distributed rate limiting challenges",
                  source: "Tech blog",
                  reasoning: "Consistency vs availability tradeoff",
                },
              ],
            },
            synthesize: {
              answer: "Token bucket with redis for distributed systems",
              conclusions: [
                { statement: "Use 429 status", supporting_sources: [1] },
                { statement: "Include Retry-After", supporting_sources: [1, 2] },
                { statement: "Consider distributed cache", supporting_sources: [3] },
              ],
            },
            limitations: {
              gaps: ["Limited to HTTP APIs", "Not covering gRPC patterns"],
              source_biases: ["Vendor documentation may be biased toward their solutions"],
              methodology_biases: ["Focus on English-language sources only"],
            },
            output: {
              report_delivered: "yes",
              sources_cited: 15,
              sections_count: 5,
            },
          },
        },

        // Scenario 2: Minimal verified-research
        {
          name: "Minimal verified-research inputs",
          description: "Research with minimal required data at each step",
          expect: { status: "completed" },
          mockInputs: {
            question: {
              research_question: "Basic API security",
              success_criteria: ["List of security practices"],
              scope_in: ["REST APIs"],
              scope_out: ["GraphQL"],
            },
            methodology: {
              source_types: ["documentation"],
              keywords: ["API security", "best practices"],
              quality_criteria: ["Any official docs"],
              time_period: "last 2 years",
            },
            gather: {
              sources: [
                {
                  title: "OWASP",
                  url: "https://owasp.org",
                  type: "documentation",
                  relevance_note: "Security standards",
                },
                {
                  title: "NIST",
                  url: "https://nist.gov",
                  type: "academic",
                  relevance_note: "Security frameworks",
                },
                {
                  title: "Auth0",
                  url: "https://auth0.com/docs",
                  type: "industry",
                  relevance_note: "Auth patterns",
                },
                {
                  title: "OAuth RFC",
                  url: "https://tools.ietf.org",
                  type: "academic",
                  relevance_note: "Standards",
                },
                {
                  title: "MDN",
                  url: "https://developer.mozilla.org",
                  type: "documentation",
                  relevance_note: "Web security",
                },
              ],
            },
            read: {
              readings: [
                { source_id: 1, main_finding: "Use HTTPS for all APIs" },
                { source_id: 2, main_finding: "Follow security frameworks" },
                { source_id: 3, main_finding: "Implement proper authentication" },
              ],
            },
            alternative: {
              alternative_views: [
                {
                  viewpoint: "Zero-trust approach",
                  source: "Google BeyondCorp",
                  reasoning: "Network perimeter is outdated",
                },
                {
                  viewpoint: "API keys vs OAuth",
                  source: "Industry discussion",
                  reasoning: "Simplicity vs security tradeoff",
                },
              ],
            },
            synthesize: {
              answer: "Standard security practices apply",
              conclusions: [
                { statement: "Use HTTPS", supporting_sources: [1] },
                { statement: "Validate input", supporting_sources: [1, 2] },
              ],
            },
            limitations: {
              gaps: ["Basic overview only"],
              source_biases: ["Limited to mainstream sources"],
              methodology_biases: ["Quick verified-research approach"],
            },
            output: {
              report_delivered: "yes",
              sources_cited: 5,
            },
          },
        },

        // Scenario 3: Complex multi-topic verified-research
        {
          name: "Complex multi-topic verified-research",
          description: "Research covering multiple interconnected topics",
          expect: { status: "completed" },
          mockInputs: {
            question: {
              research_question: "Microservices authentication patterns",
              success_criteria: ["Comparison of OAuth2, JWT, and mTLS for microservices"],
              scope_in: ["Cloud-native microservices"],
              scope_out: ["Monolithic applications"],
              audience: "Backend developers",
            },
            methodology: {
              source_types: ["academic", "industry", "case-study"],
              keywords: ["OAuth2 microservices", "JWT authentication", "mTLS service mesh"],
              quality_criteria: ["Production-proven patterns only"],
              time_period: "Last 3 years",
            },
            gather: {
              sources: [
                {
                  title: "OWASP API Security",
                  url: "https://owasp.org/api",
                  type: "documentation",
                  relevance_note: "Security standards",
                },
                {
                  title: "OAuth 2.0 RFC",
                  url: "https://tools.ietf.org/rfc6749",
                  type: "academic",
                  relevance_note: "OAuth specs",
                },
                {
                  title: "Netflix mTLS",
                  url: "https://netflix.com/blog",
                  type: "case-study",
                  relevance_note: "Production patterns",
                },
                {
                  title: "Istio docs",
                  url: "https://istio.io/docs",
                  type: "documentation",
                  relevance_note: "Service mesh auth",
                },
                {
                  title: "Google Zero Trust",
                  url: "https://cloud.google.com/beyondcorp",
                  type: "industry",
                  relevance_note: "Zero trust model",
                },
              ],
            },
            read: {
              readings: [
                {
                  source_id: 1,
                  main_finding: "Token validation best practices",
                  key_quotes: ["Rate limiting required"],
                },
                {
                  source_id: 2,
                  main_finding: "Bearer tokens and scopes",
                  key_quotes: ["Short-lived tokens recommended"],
                },
                {
                  source_id: 3,
                  main_finding: "Service mesh patterns",
                  key_quotes: ["Certificate rotation critical"],
                },
              ],
            },
            alternative: {
              alternative_views: [
                {
                  viewpoint: "Zero-trust vs perimeter security",
                  source: "Google BeyondCorp",
                  reasoning: "Network perimeter obsolete",
                },
                {
                  viewpoint: "Performance overhead concerns",
                  source: "Industry benchmarks",
                  reasoning: "mTLS adds latency",
                },
              ],
              controversies: ["Complexity vs security tradeoffs"],
            },
            synthesize: {
              answer: "Layered approach: mTLS for internal, OAuth2 at gateway",
              conclusions: [
                { statement: "Use mTLS for service-to-service", supporting_sources: [3, 4] },
                { statement: "OAuth2 for external clients", supporting_sources: [2] },
                { statement: "Short-lived JWTs for sessions", supporting_sources: [1, 2] },
              ],
              agreements: ["mTLS is most secure for internal"],
              disagreements: ["JWT vs opaque tokens debate"],
            },
            limitations: {
              gaps: ["Not covering serverless patterns"],
              source_biases: ["Vendor documentation may be biased"],
              methodology_biases: ["English sources only"],
            },
            output: {
              report_delivered: "yes",
              sources_cited: 25,
              sections_count: 8,
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
