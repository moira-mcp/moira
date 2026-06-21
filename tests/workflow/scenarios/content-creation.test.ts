/**
 * content-creation Scenario Tests
 *
 * Content creation workflow with research, outline, and draft phases.
 * Coverage target: 100% nodes (24), 100% branches
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
  return findSystemCatalogEntry("content-creation", "public")!.graph as WorkflowGraph;
}

describe("content-creation Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "content-creation"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected cycles (revision loops)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(30);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        // Scenario 1: Happy path - all steps pass first time
        {
          name: "Happy path - all approvals immediate",
          description: "Research, outline, draft all approved on first attempt",
          expect: { status: "completed" },
          mockInputs: {
            "get-brief": {
              topic: "API Design Best Practices",
              format: "article",
              target_audience: "Developers",
              tone: "technical",
              user_response_text: "Yes, I want an article about API design",
            },
            "research-topic": {
              sources: ["REST API guidelines", "GraphQL best practices", "OpenAPI specification"],
              key_facts: ["RESTful principles", "API versioning", "Error handling patterns"],
              research_summary:
                "Comprehensive API design research covering REST, GraphQL, and OpenAPI standards",
              research_complete: "yes",
            },
            "create-outline": {
              outline: [
                {
                  section: "Introduction",
                  key_points: ["Hook with API importance", "Overview of best practices"],
                },
                { section: "Principles", key_points: ["RESTful design", "Versioning strategies"] },
                { section: "Examples", key_points: ["Real-world implementations", "Code samples"] },
                { section: "Conclusion", key_points: ["Key takeaways", "Next steps"] },
              ],
              outline_summary: "Four-section structure",
            },
            "approve-outline": {
              outline_approved: "yes",
              user_response_text: "approved",
            },
            "write-draft": {
              draft_content:
                "This comprehensive guide covers API design best practices for modern web development. We explore RESTful principles, versioning strategies, error handling patterns, and authentication mechanisms. The article provides practical examples and code samples that developers can immediately apply to their projects. Key topics include endpoint naming conventions, HTTP status codes, and documentation standards.",
              word_count: 1500,
              draft_complete: "yes",
            },
            "review-edit": {
              edited_content:
                "This comprehensive guide covers API design best practices for modern web development. We explore RESTful principles, versioning strategies, error handling patterns, and authentication mechanisms. The content has been edited for clarity and improved readability throughout all sections.",
              changes_made: ["Improved clarity", "Fixed typos"],
            },
            "approve-content": {
              content_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              final_content:
                "This comprehensive guide covers API design best practices for modern web development. We explore RESTful principles, versioning strategies, error handling patterns, and authentication mechanisms. The article provides practical examples and code samples that developers can immediately apply to their projects.",
              final_word_count: 1500,
              final_summary: "Complete blog post about API design",
            },
          },
        },

        // Scenario 2: Research needs fix
        {
          name: "Research incomplete - needs fix",
          description: "Initial research incomplete, fixed and resubmitted",
          expect: { status: "completed" },
          mockInputs: {
            "get-brief": {
              topic: "Docker Networking",
              format: "documentation",
              target_audience: "DevOps engineers",
              tone: "technical",
              user_response_text: "Yes, I need documentation about Docker networking",
            },
            "research-topic": [
              {
                sources: ["Docker docs", "K8s networking guide", "CNI specification"],
                key_facts: ["Basic networking", "Bridge networks", "Overlay networks"],
                research_summary:
                  "Initial research on Docker and Kubernetes networking fundamentals",
                research_complete: "no",
              },
              {
                sources: ["Docker docs", "K8s networking guide", "CNI specification"],
                key_facts: ["Bridge networks", "Overlay networks", "CNI plugins"],
                research_summary:
                  "Complete networking research covering Docker, Kubernetes, and CNI standards",
                research_complete: "yes",
              },
            ],
            "fix-research": {
              additional_sources: ["Kubernetes networking", "Container networking deep dive"],
              additional_facts: ["CNI plugins", "Network policies"],
            },
            "create-outline": {
              outline: [
                {
                  section: "Basics",
                  key_points: ["Docker networking fundamentals", "Network types"],
                },
                { section: "Bridge Networks", key_points: ["Configuration", "Use cases"] },
                {
                  section: "Overlay Networks",
                  key_points: ["Multi-host networking", "Swarm integration"],
                },
              ],
              outline_summary: "Three-section tutorial",
            },
            "approve-outline": {
              outline_approved: "yes",
              user_response_text: "approved",
            },
            "write-draft": {
              draft_content:
                "Docker networking is a fundamental concept for containerized applications. This tutorial covers the basics of Docker networks, including bridge networks for single-host communication and overlay networks for multi-host deployments. You will learn how to configure network drivers, manage container connectivity, and troubleshoot common networking issues in production environments.",
              word_count: 2000,
              draft_complete: "yes",
            },
            "review-edit": {
              edited_content:
                "Docker networking is a fundamental concept for containerized applications. This tutorial covers the basics of Docker networks, including bridge networks for single-host communication and overlay networks for multi-host deployments. The content has been thoroughly edited with examples and improved clarity.",
              changes_made: ["Added examples"],
            },
            "approve-content": {
              content_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              final_content:
                "Docker networking is a fundamental concept for containerized applications. This tutorial covers the basics of Docker networks, including bridge networks for single-host communication and overlay networks for multi-host deployments. Complete guide with examples and troubleshooting tips.",
              final_word_count: 2000,
              final_summary: "Docker networking tutorial",
            },
          },
        },

        // Scenario 3: Outline rejection and revision
        {
          name: "Outline rejected - needs revision",
          description: "Outline not approved, revised and resubmitted",
          expect: { status: "completed" },
          mockInputs: {
            "get-brief": {
              topic: "Testing Strategies",
              format: "article",
              target_audience: "QA engineers",
              tone: "formal",
              user_response_text: "Yes, I want a formal article about testing strategies",
            },
            "research-topic": {
              sources: ["Testing pyramid", "TDD guide", "Kent Beck's TDD book"],
              key_facts: ["Unit tests", "Integration tests", "E2E tests"],
              research_summary:
                "Testing best practices research covering pyramid strategy and TDD methodology",
              research_complete: "yes",
            },
            "create-outline": [
              {
                outline: [
                  { section: "Unit tests only", key_points: ["Basic testing"] },
                  { section: "Introduction", key_points: ["Overview"] },
                  { section: "Summary", key_points: ["Conclusion"] },
                ],
                outline_summary: "Initial simple outline",
              },
              {
                outline: [
                  { section: "Unit", key_points: ["Unit test fundamentals"] },
                  { section: "Integration", key_points: ["API testing", "Database testing"] },
                  { section: "E2E", key_points: ["End-to-end scenarios"] },
                  { section: "Performance", key_points: ["Load testing", "Benchmarks"] },
                ],
                outline_summary: "Comprehensive four-section outline",
              },
            ],
            "approve-outline": [
              {
                outline_approved: "no",
                outline_feedback: "Too narrow",
                user_response_text: "needs more coverage",
              },
              {
                outline_approved: "yes",
                user_response_text: "approved",
              },
            ],
            "revise-outline": {
              revised_outline:
                "Revised structure with four comprehensive sections: Unit Testing covering fundamentals and mocking, Integration Testing for API and database tests, E2E Testing with Playwright scenarios, and Performance Testing including load tests and benchmarks.",
            },
            "write-draft": {
              draft_content:
                "A comprehensive guide to testing strategies for modern software development. This article covers the testing pyramid approach, test-driven development methodology, and practical implementation patterns. You will learn about unit testing with Jest, integration testing for APIs, end-to-end testing with Playwright, and performance testing strategies to ensure your application meets quality standards.",
              word_count: 3000,
              draft_complete: "yes",
            },
            "review-edit": {
              edited_content:
                "A comprehensive guide to testing strategies for modern software development. This article covers the testing pyramid approach, test-driven development methodology, and practical implementation patterns. The content has been thoroughly reviewed and polished with code examples added throughout all sections.",
              changes_made: ["Added code examples"],
            },
            "approve-content": {
              content_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              final_content:
                "A comprehensive guide to testing strategies for modern software development. This article covers the testing pyramid approach, test-driven development methodology, and practical implementation patterns. Complete guide with code examples covering unit, integration, and E2E testing.",
              final_word_count: 3000,
              final_summary: "Complete testing strategies guide",
            },
          },
        },

        // Scenario 4: Draft incomplete - needs fix
        {
          name: "Draft incomplete - needs fix",
          description: "Draft check fails, fixed and resubmitted",
          expect: { status: "completed" },
          mockInputs: {
            "get-brief": {
              topic: "CI/CD Pipelines",
              format: "documentation",
              target_audience: "Developers",
              tone: "technical",
              user_response_text: "Yes, I need documentation about CI/CD pipelines",
            },
            "research-topic": {
              sources: ["GitHub Actions docs", "Jenkins guide", "CircleCI documentation"],
              key_facts: ["Pipeline stages", "Deployment strategies", "Parallel execution"],
              research_summary:
                "CI/CD research covering major platforms including GitHub Actions, Jenkins, and CircleCI",
              research_complete: "yes",
            },
            "create-outline": {
              outline: [
                {
                  section: "Setup",
                  key_points: ["Environment configuration", "Tool installation"],
                },
                { section: "Build Stage", key_points: ["Compilation", "Testing", "Artifacts"] },
                {
                  section: "Deploy Stage",
                  key_points: ["Deployment strategies", "Rollback procedures"],
                },
              ],
              outline_summary: "Three-stage pipeline outline",
            },
            "approve-outline": {
              outline_approved: "yes",
              user_response_text: "approved",
            },
            "write-draft": [
              {
                draft_content:
                  "This is an incomplete draft that covers only the basic setup section of the CI/CD pipeline tutorial. More content is needed for build and deploy stages. The current version lacks practical examples and detailed configuration instructions that are essential for a complete guide.",
                word_count: 500,
                draft_complete: "no",
              },
              {
                draft_content:
                  "A complete guide to CI/CD pipelines covering setup, build, and deployment stages. This tutorial walks you through configuring GitHub Actions and Jenkins for automated builds, running tests in parallel, managing artifacts, and implementing deployment strategies including blue-green deployments and rollback procedures. Includes practical examples and best practices for production environments.",
                word_count: 2500,
                draft_complete: "yes",
              },
            ],
            "fix-draft": {
              improvements_made:
                "Added deploy section with blue-green deployment examples and rollback procedures",
            },
            "review-edit": {
              edited_content:
                "A complete guide to CI/CD pipelines covering setup, build, and deployment stages. This tutorial walks you through configuring GitHub Actions and Jenkins for automated builds, running tests in parallel, managing artifacts, and implementing deployment strategies. Content has been edited for improved clarity.",
              changes_made: ["Improved clarity"],
            },
            "approve-content": {
              content_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              final_content:
                "A complete guide to CI/CD pipelines covering setup, build, and deployment stages. This tutorial walks you through configuring GitHub Actions and Jenkins for automated builds, running tests in parallel, managing artifacts, and implementing deployment strategies including blue-green deployments.",
              final_word_count: 2500,
              final_summary: "Complete CI/CD pipeline tutorial",
            },
          },
        },

        // Scenario 5: Content rejected - needs revision
        {
          name: "Content rejected - needs revision",
          description: "Final content not approved, revised and resubmitted",
          expect: { status: "completed" },
          mockInputs: {
            "get-brief": {
              topic: "Security Hardening",
              format: "documentation",
              target_audience: "Security teams",
              tone: "formal",
              user_response_text: "Yes, I need formal documentation about security hardening",
            },
            "research-topic": {
              sources: ["OWASP", "CIS Benchmarks", "NIST Cybersecurity Framework"],
              key_facts: ["Firewall rules", "Auth best practices", "Encryption standards"],
              research_summary:
                "Security hardening research covering OWASP, CIS Benchmarks, and NIST framework",
              research_complete: "yes",
            },
            "create-outline": {
              outline: [
                { section: "Firewall", key_points: ["Rules configuration", "Port management"] },
                { section: "Authentication", key_points: ["MFA setup", "Password policies"] },
                { section: "Audit Logging", key_points: ["Log collection", "Monitoring alerts"] },
              ],
              outline_summary: "Three-section checklist",
            },
            "approve-outline": {
              outline_approved: "yes",
              user_response_text: "approved",
            },
            "write-draft": {
              draft_content:
                "A comprehensive security hardening checklist for production systems. This documentation covers firewall configuration including port management and rule optimization, authentication best practices with MFA implementation and password policies, and audit logging setup with centralized log collection and real-time monitoring alerts. Each section includes step-by-step instructions and verification procedures.",
              word_count: 1800,
              draft_complete: "yes",
            },
            "review-edit": [
              {
                edited_content:
                  "A comprehensive security hardening checklist for production systems. This documentation covers firewall configuration including port management and rule optimization, authentication best practices with MFA implementation and password policies. Initial edit with basic improvements to structure and clarity.",
                changes_made: ["Basic improvements"],
              },
              {
                edited_content:
                  "A comprehensive security hardening checklist for production systems. This documentation covers firewall configuration, authentication best practices, and audit logging setup. Final edit with practical examples added throughout all sections including step-by-step verification procedures.",
                changes_made: ["Added practical examples"],
              },
            ],
            "approve-content": [
              {
                content_approved: "no",
                content_feedback: "Needs more examples",
                user_response_text: "add examples",
              },
              {
                content_approved: "yes",
                user_response_text: "approved",
              },
            ],
            "revise-content": {
              retry_count: 0,
            },
            finalize: {
              final_content:
                "A comprehensive security hardening checklist for production systems. This documentation covers firewall configuration including port management, authentication best practices with MFA implementation and password policies, and audit logging setup with centralized log collection and real-time monitoring.",
              final_word_count: 2000,
              final_summary: "Complete security hardening checklist",
            },
          },
        },

        // Scenario 6: Research fix limit reached - escapes to create-outline
        {
          name: "Research fix limit reached - escape loop",
          description: "Research fix iterations exhausted (3 attempts), escapes to outline phase",
          expect: { status: "completed" },
          mockInputs: {
            "get-brief": {
              topic: "Kubernetes Scaling",
              format: "article",
              target_audience: "Platform engineers",
              tone: "technical",
              user_response_text: "Yes, write about Kubernetes scaling strategies",
            },
            // 3 attempts all return research_complete: "no" to exhaust the fix loop
            "research-topic": [
              {
                sources: ["K8s docs", "HPA guide", "Cluster autoscaler documentation"],
                key_facts: ["HPA configuration", "VPA strategies", "Cluster autoscaler setup"],
                research_summary:
                  "Initial Kubernetes scaling research covering horizontal and vertical pod autoscaling",
                research_complete: "no",
              },
              {
                sources: ["K8s docs", "HPA guide", "Cluster autoscaler documentation"],
                key_facts: ["HPA configuration", "VPA strategies", "Cluster autoscaler setup"],
                research_summary:
                  "Second attempt at Kubernetes scaling research with additional pod autoscaling detail",
                research_complete: "no",
              },
              {
                sources: ["K8s docs", "HPA guide", "Cluster autoscaler documentation"],
                key_facts: ["HPA configuration", "VPA strategies", "Cluster autoscaler setup"],
                research_summary:
                  "Third attempt at Kubernetes scaling research still incomplete after all fixes",
                research_complete: "no",
              },
            ],
            "fix-research": [
              { additional_sources: ["VPA docs"], additional_facts: ["VPA metrics"] },
              { additional_sources: ["Autoscaler docs"], additional_facts: ["Node pools"] },
            ],
            // After 3rd "no", expr increments to 3, check: 3 < 3 = false → ask-user-research-fix-limit-reached
            "ask-user-research-fix-limit-reached": { decision: "continue" },
            "create-outline": {
              outline: [
                { section: "HPA", key_points: ["Horizontal pod autoscaling"] },
                { section: "VPA", key_points: ["Vertical pod autoscaling"] },
                { section: "Cluster Autoscaler", key_points: ["Node scaling"] },
              ],
              outline_summary: "Three-section scaling guide",
            },
            "approve-outline": {
              outline_approved: "yes",
              user_response_text: "approved",
            },
            "write-draft": {
              draft_content:
                "Kubernetes scaling guide covering HPA, VPA, and Cluster Autoscaler strategies for production workloads. This comprehensive guide helps platform engineers understand scaling options and implement autoscaling in their Kubernetes clusters effectively.",
              word_count: 1200,
              draft_complete: "yes",
            },
            "review-edit": {
              edited_content:
                "Kubernetes scaling guide covering HPA, VPA, and Cluster Autoscaler strategies for production workloads. Edited for clarity and completeness with practical examples added throughout all sections including configuration snippets and deployment strategies for real-world environments.",
              changes_made: ["Improved clarity"],
            },
            "approve-content": {
              content_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              final_content:
                "Kubernetes scaling guide covering HPA, VPA, and Cluster Autoscaler strategies for production workloads. This comprehensive guide helps platform engineers understand and implement autoscaling options for their Kubernetes clusters in production environments with practical examples.",
              final_word_count: 1200,
              final_summary: "Kubernetes scaling article",
            },
          },
        },

        // Scenario 7: Draft fix limit reached - escapes to review-edit
        {
          name: "Draft fix limit reached - escape loop",
          description: "Draft fix iterations exhausted (3 attempts), escapes to review-edit phase",
          expect: { status: "completed" },
          mockInputs: {
            "get-brief": {
              topic: "Monitoring Best Practices",
              format: "documentation",
              target_audience: "SRE teams",
              tone: "technical",
              user_response_text: "Yes, document monitoring best practices for SRE teams",
            },
            "research-topic": {
              sources: ["Prometheus docs", "Grafana guide", "SRE book by Google"],
              key_facts: ["Metrics collection", "Alerting strategies", "Dashboard design"],
              research_summary:
                "Monitoring research covering Prometheus, Grafana, and SRE best practices for teams",
              research_complete: "yes",
            },
            "create-outline": {
              outline: [
                { section: "Metrics", key_points: ["Collection", "Storage"] },
                { section: "Alerting", key_points: ["Rules", "Routing"] },
                { section: "Dashboards", key_points: ["Design", "Best practices"] },
              ],
              outline_summary: "Three-section monitoring guide",
            },
            "approve-outline": {
              outline_approved: "yes",
              user_response_text: "approved",
            },
            // 3 attempts all return draft_complete: "no" to exhaust the fix loop
            "write-draft": [
              {
                draft_content:
                  "Incomplete monitoring draft that needs significantly more work on the alerting section and dashboard design patterns. The metrics collection section covers basic Prometheus setup but lacks detail on configurations.",
                word_count: 800,
                draft_complete: "no",
              },
              {
                draft_content:
                  "Second attempt at monitoring draft still missing alerting rules and dashboard templates. The metrics section has been improved but alerting and dashboards need more practical examples for production use.",
                word_count: 1000,
                draft_complete: "no",
              },
              {
                draft_content:
                  "Third attempt at monitoring draft remains incomplete despite multiple fixes. Needs more comprehensive coverage of alerting strategies and dashboard best practices for SRE teams in production environments and beyond.",
                word_count: 1100,
                draft_complete: "no",
              },
            ],
            "fix-draft": [
              { improvements_made: "Added alerting examples and basic dashboard templates" },
              {
                improvements_made: "Expanded dashboard section with Grafana configuration details",
              },
            ],
            // After 3rd "no", expr increments to 3, check: 3 < 3 = false → ask-user-draft-fix-limit-reached
            "ask-user-draft-fix-limit-reached": { decision: "continue" },
            "review-edit": {
              edited_content:
                "Monitoring best practices guide covering metrics collection, alerting strategies, and dashboard design patterns. Edited for completeness with practical examples added throughout all sections including Prometheus configuration snippets and Grafana dashboard templates.",
              changes_made: ["Added missing sections"],
            },
            "approve-content": {
              content_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              final_content:
                "Monitoring best practices guide covering metrics collection, alerting strategies, and dashboard design patterns for SRE teams. Includes practical examples of Prometheus configuration, Grafana dashboards, and alerting rules for production environments.",
              final_word_count: 1500,
              final_summary: "Monitoring documentation",
            },
          },
        },
        // Scenario 8: Research and draft fix limit reached - user resets counters
        {
          name: "Fix limit reached - user resets counters",
          description:
            "Research and draft fix limits reached, user resets counters to retry fixing",
          expect: { status: "completed" },
          mockInputs: {
            "get-brief": {
              topic: "GraphQL Federation",
              format: "article",
              target_audience: "Backend developers",
              tone: "technical",
              user_response_text: "Yes, write about GraphQL Federation patterns",
            },
            // Research: fail 3 times, then reset, then fix succeeds
            "research-topic": [
              {
                sources: ["Apollo Federation docs", "GraphQL spec", "Subgraph patterns guide"],
                key_facts: ["Schema stitching basics", "Gateway concepts", "Subgraph design"],
                research_summary:
                  "Initial GraphQL federation research attempt covering basic concepts but missing depth",
                research_complete: "no",
              },
              {
                sources: ["Apollo Federation docs", "GraphQL spec", "Subgraph patterns guide"],
                key_facts: ["Schema stitching basics", "Gateway concepts", "Subgraph design"],
                research_summary:
                  "Second federation research attempt with improved coverage but still incomplete",
                research_complete: "no",
              },
              {
                sources: ["Apollo Federation docs", "GraphQL spec", "Subgraph patterns guide"],
                key_facts: ["Schema stitching basics", "Gateway concepts", "Subgraph design"],
                research_summary:
                  "Third federation research attempt still incomplete despite multiple fix iterations",
                research_complete: "no",
              },
              // After reset, fix-research runs and then research-topic is called again
              {
                sources: ["Apollo Federation docs", "GraphQL spec", "Subgraph patterns guide"],
                key_facts: ["Schema stitching", "Subgraph composition", "Gateway routing"],
                research_summary:
                  "Complete GraphQL federation research after counter reset and additional fixes applied",
                research_complete: "yes",
              },
            ],
            "fix-research": [
              { additional_sources: ["Apollo docs"], additional_facts: ["Gateway patterns"] },
              { additional_sources: ["Spec docs"], additional_facts: ["Composition rules"] },
              // After reset, fix-research is called once more before research-topic succeeds
              { additional_sources: ["Advanced docs"], additional_facts: ["Error handling"] },
            ],
            "ask-user-research-fix-limit-reached": { decision: "reset" },
            "create-outline": {
              outline: [
                { section: "Federation Basics", key_points: ["Subgraph architecture"] },
                { section: "Gateway", key_points: ["Query routing", "Composition"] },
                { section: "Best Practices", key_points: ["Error handling", "Monitoring"] },
              ],
              outline_summary: "Three-section federation guide",
            },
            "approve-outline": {
              outline_approved: "yes",
              user_response_text: "approved",
            },
            // Draft: fail 3 times, then reset, then fix succeeds
            "write-draft": [
              {
                draft_content:
                  "Incomplete federation draft attempt one covering only basic concepts of GraphQL Federation. This draft needs significantly more work on gateway routing, subgraph composition patterns, and error handling strategies for distributed GraphQL APIs in production environments.",
                word_count: 400,
                draft_complete: "no",
              },
              {
                draft_content:
                  "Incomplete federation draft attempt two with improved gateway section but still missing subgraph composition details. The content covers basic Federation concepts and gateway routing but lacks depth on schema stitching patterns and error propagation across subgraphs in production.",
                word_count: 600,
                draft_complete: "no",
              },
              {
                draft_content:
                  "Incomplete federation draft attempt three remains incomplete despite multiple fix iterations. Gateway and basic composition covered but advanced patterns, monitoring, and error handling sections are still missing from the comprehensive guide for backend developers.",
                word_count: 700,
                draft_complete: "no",
              },
              // After reset, fix-draft runs and write-draft succeeds
              {
                draft_content:
                  "Complete GraphQL Federation guide covering subgraph architecture, gateway routing, and composition patterns for building scalable distributed APIs. This comprehensive guide walks backend developers through the entire Federation setup including schema design, subgraph development, gateway configuration, error handling, and monitoring strategies for production environments.",
                word_count: 2000,
                draft_complete: "yes",
              },
            ],
            "fix-draft": [
              { improvements_made: "Added gateway section details" },
              { improvements_made: "Expanded composition examples" },
              // After reset
              { improvements_made: "Added error handling and monitoring sections" },
            ],
            "ask-user-draft-fix-limit-reached": { decision: "reset" },
            "review-edit": {
              edited_content:
                "Complete GraphQL Federation guide with subgraph architecture, gateway routing, and composition patterns for building scalable distributed APIs. This comprehensive guide has been edited for clarity with practical examples, improved code snippets, and better transitions between sections for backend developers.",
              changes_made: ["Polished content", "Improved code examples"],
            },
            "approve-content": {
              content_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              final_content:
                "Complete GraphQL Federation guide for backend developers covering subgraph architecture, gateway routing, and composition patterns for building scalable distributed APIs. This guide provides practical examples and best practices for implementing Federation in production environments with proper error handling and monitoring.",
              final_word_count: 2000,
              final_summary: "GraphQL Federation article",
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
