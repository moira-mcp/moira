/**
 * architecture-design-flow Scenario Tests
 *
 * Two-path architecture design workflow:
 * - New project: gather-context → requirements → domain → system-context → detailed-design → shared stages
 * - Existing project: gather-context → project-scan → reverse-engineer → current-state → improvements → shared stages
 * Shared: confirm-scope → subagent-review (fix cycle) → ADRs → quality → crosscutting → docs → review → present
 *
 * Coverage target: 100% nodes (30), 100% branches (12)
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
  return findSystemCatalogEntry("architecture-design-flow", "public")!.graph as WorkflowGraph;
}

// -- Reusable mock input fragments (matching inputSchema exactly) --

const newProjectContext = {
  project_name: "OrderTracker",
  project_description: "Real-time order tracking microservice",
  scenario_type: "new",
  primary_goals: ["Design scalable tracking service", "Define bounded contexts"],
};

const existingProjectContext = {
  project_name: "LegacyBilling",
  project_description: "Existing billing monolith needing modernization",
  scenario_type: "existing",
  primary_goals: ["Analyze current architecture", "Identify improvement areas"],
  project_path: "/src/billing",
};

const requirementsMock = {
  stakeholders: [
    { role: "Product Owner", concerns: "Feature velocity and time-to-market" },
    { role: "SRE Engineer", concerns: "Uptime, observability, and incident response" },
  ],
  functional_requirements: [
    { requirement: "Track order location in real-time", priority: "must" as const },
    { requirement: "Send push notifications on status change", priority: "must" as const },
    { requirement: "Show estimated delivery time", priority: "should" as const },
  ],
  non_functional_requirements: [
    { attribute: "Performance", target: "p99 latency < 200ms" },
    { attribute: "Availability", target: "99.95% uptime" },
    { attribute: "Scalability", target: "Handle 10k concurrent requests" },
  ],
  constraints: [
    { type: "technical" as const, constraint: "Must integrate with existing carrier APIs" },
  ],
  key_use_cases: [
    { name: "Track Order", flow: "Customer opens app → sees map with package location" },
    { name: "Receive Notification", flow: "Status changes → system sends push notification" },
    { name: "View History", flow: "Customer opens order → sees timeline of events" },
  ],
  success_criteria: ["Reduce support tickets by 40%"],
};

const domainAnalysisMock = {
  glossary: [
    { term: "Shipment", definition: "A physical package in transit" },
    { term: "Tracking Event", definition: "A status update from a carrier" },
    { term: "Carrier", definition: "Third-party logistics provider" },
    { term: "ETA", definition: "Estimated time of arrival" },
    { term: "Waypoint", definition: "A location checkpoint in transit" },
    { term: "Delivery Zone", definition: "Geographic area for delivery routing" },
    { term: "Notification Channel", definition: "Medium for sending alerts (push, email, SMS)" },
    { term: "Subscription", definition: "User opt-in for tracking notifications" },
    { term: "Status", definition: "Current state of a shipment lifecycle" },
    { term: "Handoff", definition: "Transfer of package between carriers" },
  ],
  subdomains: [
    { name: "Tracking", type: "core" as const },
    { name: "Notification", type: "supporting" as const },
  ],
  bounded_contexts: [
    {
      name: "Tracking Context",
      responsibility: "Real-time location and status tracking",
      owned_entities: ["Shipment", "TrackingEvent", "Waypoint"],
    },
    {
      name: "Notification Context",
      responsibility: "User notification delivery",
      owned_entities: ["Subscription", "NotificationTemplate"],
    },
  ],
  context_map_mermaid: "graph LR\n  Tracking -->|events| Notification",
};

const systemContextMock = {
  system_boundary: "OrderTracker Service boundary",
  user_roles: [
    { role: "Customer", interactions: "Views order tracking, receives notifications" },
    { role: "Admin", interactions: "Monitors system health, manages carriers" },
  ],
  context_diagram_mermaid: "graph TD\n  Customer --> OrderTracker\n  OrderTracker --> CarrierAPI",
};

const detailedDesignMock = {
  containers: [
    {
      name: "API Gateway",
      technology: "Node.js/Express",
      responsibility: "Request routing and auth",
    },
    { name: "Tracking Service", technology: "Go", responsibility: "Core tracking logic" },
    { name: "Notification Service", technology: "Node.js", responsibility: "Push notifications" },
  ],
  container_diagram_mermaid:
    "graph TD\n  GW[API Gateway] --> TS[Tracking Service]\n  TS --> NS[Notification Service]",
  component_designs: [
    {
      container_name: "Tracking Service",
      components: [
        { name: "LocationProcessor", responsibility: "Process carrier updates" },
        { name: "ETACalculator", responsibility: "Calculate delivery estimates" },
      ],
      component_diagram_mermaid: "graph TD\n  LP[LocationProcessor] --> EC[ETACalculator]",
    },
  ],
  technology_choices: [
    {
      technology: "Go",
      purpose: "Tracking service runtime",
      justification: "High performance for event processing",
    },
    {
      technology: "Kafka",
      purpose: "Event streaming",
      justification: "Reliable async communication",
    },
  ],
};

const projectScanMock = {
  directory_structure: "src/\n  billing/\n  payments/\n  shared/",
  languages: [
    { language: "Java", version: "17", file_count: 150 },
    { language: "SQL", file_count: 30 },
  ],
  frameworks: [{ name: "Spring Boot", version: "3.1", purpose: "Web framework and DI" }],
  key_dependencies: ["PostgreSQL", "Redis"],
  build_system: "Gradle",
  deployment_mechanism: "Docker + K8s",
  test_infrastructure: "JUnit 5",
  entry_points: ["BillingApplication.java", "PaymentController.java"],
  existing_documentation: ["README.md"],
};

const reverseEngineerMock = {
  containers: [
    { name: "Billing Monolith", technology: "Java/Spring", responsibility: "All billing logic" },
    { name: "PostgreSQL", technology: "PostgreSQL 14", responsibility: "Data storage" },
  ],
  container_diagram_mermaid: "graph TD\n  Monolith[Billing Monolith] --> DB[(PostgreSQL)]",
  component_designs: [
    {
      container_name: "Billing Monolith",
      components: [
        { name: "InvoiceService", responsibility: "Invoice CRUD" },
        { name: "PaymentProcessor", responsibility: "Payment handling" },
      ],
      component_diagram_mermaid: "graph TD\n  IS[InvoiceService] --> PP[PaymentProcessor]",
    },
  ],
  architectural_pattern: "Modular monolith",
  traced_use_cases: [
    { name: "Create Invoice", trace: "Controller → InvoiceService → Repository → DB" },
    { name: "Process Payment", trace: "Controller → PaymentProcessor → Gateway → DB" },
  ],
  bounded_contexts: [
    { name: "Invoicing", responsibility: "Invoice lifecycle management" },
    { name: "Payments", responsibility: "Payment processing and refunds" },
  ],
  context_map_mermaid: "graph LR\n  Invoicing -->|shared-kernel| Payments",
  shared_models: ["Money", "CustomerId"],
  glossary: [
    { term: "Invoice", definition: "A bill for services rendered" },
    { term: "LineItem", definition: "A single entry on an invoice" },
    { term: "Payment", definition: "A monetary transaction" },
    { term: "Refund", definition: "A reversal of a payment" },
    { term: "Customer", definition: "A billing account holder" },
  ],
};

const currentStateMock = {
  context_diagram_mermaid: "graph TD\n  User --> BillingApp\n  BillingApp --> DB[(PostgreSQL)]",
  current_quality_attributes: [
    { attribute: "Performance", current_state: "p99 ~500ms under normal load" },
    { attribute: "Maintainability", current_state: "High coupling between modules" },
    { attribute: "Reliability", current_state: "Single point of failure on DB" },
  ],
  gaps: [
    {
      gap: "No structured logging",
      severity: "critical" as const,
      evidence: "Only println statements found",
    },
    {
      gap: "No distributed tracing",
      severity: "major" as const,
      evidence: "No tracing library in dependencies",
    },
    {
      gap: "Single database instance",
      severity: "major" as const,
      evidence: "No read replicas configured",
    },
    {
      gap: "No API versioning",
      severity: "major" as const,
      evidence: "No version prefix in routes",
    },
    { gap: "Missing health checks", severity: "minor" as const, evidence: "No /health endpoint" },
  ],
  anti_patterns_found: [
    { pattern: "Big Ball of Mud", where: "Shared database tables across modules" },
  ],
  tech_debt: [{ item: "No migration strategy for schema changes", severity: "critical" as const }],
};

const improvementsMock = {
  improvements: [
    {
      improvement: "Introduce schema-per-module pattern",
      addresses_gap: "No structured logging",
      timeline: "medium-term" as const,
      effort: "L" as const,
      success_criteria: "Each module owns its schema exclusively",
    },
    {
      improvement: "Add structured logging with OpenTelemetry",
      addresses_gap: "No distributed tracing",
      timeline: "short-term" as const,
      effort: "M" as const,
      success_criteria: "All services emit structured JSON logs with correlation IDs",
    },
    {
      improvement: "Add read replicas for PostgreSQL",
      addresses_gap: "Single database instance",
      timeline: "short-term" as const,
      effort: "S" as const,
      success_criteria: "Read queries use replica, write queries use primary",
    },
  ],
  quick_wins: ["Add structured logging", "Add health check endpoints"],
  target_container_diagram_mermaid:
    "graph TD\n  GW[API Gateway] --> BS[Billing Service]\n  GW --> PS[Payment Service]\n  BS --> DB1[(Billing DB)]\n  PS --> DB2[(Payment DB)]",
};

const scopeApproved = { scope_approved: "yes", user_feedback: "Looks good" };
const scopeRejected = { scope_approved: "no", user_feedback: "Missing security analysis" };

const reviewNoIssues = {
  review_issues_count: 0,
  blocking_issues: [] as string[],
  major_issues: [] as string[],
  minor_issues: [] as string[],
  review_summary: "Architecture is sound. No issues found.",
};

const reviewWithIssues = {
  review_issues_count: 2,
  blocking_issues: ["Missing auth boundary at API Gateway"],
  major_issues: ["No failure mode for carrier API downtime"],
  minor_issues: [] as string[],
  review_summary: "Found blocking and major issues requiring fixes.",
};

const fixArchitectureMock = {
  fixes_applied: [
    { issue: "Missing auth boundary", fix: "Added JWT validation at API Gateway" },
    { issue: "No carrier API failure mode", fix: "Added circuit breaker pattern" },
  ],
  all_blocking_fixed: "yes",
};

const adrsMock = {
  adrs: [
    {
      number: "ADR-0001",
      title: "Use Go for Tracking Service",
      decision: "Use Go for the tracking service runtime",
      alternatives_count: 3,
      adr_content:
        "# ADR-0001: Use Go for Tracking Service\n## Status\nAccepted\n## Decision\nUse Go.",
    },
    {
      number: "ADR-0002",
      title: "Use Kafka for Event Streaming",
      decision: "Use Apache Kafka for async event delivery",
      alternatives_count: 3,
      adr_content: "# ADR-0002: Use Kafka\n## Status\nAccepted\n## Decision\nUse Kafka.",
    },
    {
      number: "ADR-0003",
      title: "Separate Tracking and Notification Contexts",
      decision: "Maintain separate bounded contexts for tracking and notifications",
      alternatives_count: 2,
      adr_content: "# ADR-0003: Separate Contexts\n## Status\nAccepted\n## Decision\nSeparate.",
    },
  ],
};

const qualityAttributesMock = {
  quality_scenarios: [
    {
      attribute: "Performance",
      stimulus: "Customer requests location",
      response: "Return within 200ms",
      measure: "p99 < 200ms",
    },
    {
      attribute: "Reliability",
      stimulus: "Carrier API returns 500",
      response: "Serve cached data",
      measure: "99.95% availability",
    },
    {
      attribute: "Scalability",
      stimulus: "10x normal traffic",
      response: "Auto-scale tracking service",
      measure: "Handle 10k req/s",
    },
    {
      attribute: "Security",
      stimulus: "Invalid JWT token",
      response: "Return 401, log attempt",
      measure: "Zero unauthorized data access",
    },
    {
      attribute: "Observability",
      stimulus: "p99 exceeds 500ms",
      response: "Alert on-call within 5 min",
      measure: "MTTD < 5 min",
    },
  ],
  top_3_justification:
    "Performance, Reliability, and Scalability are top priorities for real-time tracking.",
};

const crosscuttingMock = {
  crosscutting: [
    {
      concern: "Authentication",
      approach: "JWT validation at API Gateway",
      rationale: "Centralized auth reduces duplication",
    },
    {
      concern: "Logging",
      approach: "Structured JSON logging with correlation IDs",
      rationale: "Enables distributed tracing",
    },
    {
      concern: "Error Handling",
      approach: "Circuit breaker for external calls",
      rationale: "Prevents cascade failures",
    },
    {
      concern: "Caching",
      approach: "Redis cache for frequently accessed data",
      rationale: "Reduces DB load and latency",
    },
    {
      concern: "Monitoring",
      approach: "Prometheus metrics + Grafana dashboards",
      rationale: "Real-time system observability",
    },
    {
      concern: "Configuration",
      approach: "Environment variables with validation",
      rationale: "12-factor app compliance",
    },
  ],
};

const assembleDocsMock = {
  documentation_assembled: "yes",
  artifact_count: 8,
  files_created: [
    "docs/architecture/INDEX.md",
    "docs/architecture/overview.md",
    "docs/architecture/context-diagram.md",
    "docs/architecture/container-diagram.md",
    "docs/architecture/bounded-context-map.md",
    "docs/architecture/quality-attributes.md",
    "docs/architecture/adr/0001-use-go.md",
    "docs/architecture/adr/0002-use-kafka.md",
  ],
};

const docReviewNoIssues = {
  doc_issues_count: 0,
  blocking_doc_issues: [] as string[],
  major_doc_issues: [] as string[],
  minor_doc_issues: [] as string[],
  doc_review_summary: "Documentation is complete and consistent.",
};

const docReviewWithIssues = {
  doc_issues_count: 1,
  blocking_doc_issues: [] as string[],
  major_doc_issues: ["Missing C4 Level 3 for Notification Service"],
  minor_doc_issues: [] as string[],
  doc_review_summary: "Major issue: incomplete component diagram.",
};

const fixDocsMock = {
  fixes_applied: ["Added C4 Level 3 diagram for Notification Service"],
  files_updated: ["docs/architecture/component-notification.md"],
};

const finalApproved = { final_approved: "yes" };
const finalRejected = { final_approved: "no", change_requests: ["Add glossary section"] };

const refineScopeMock = {
  changes_made: ["Added security analysis section", "Expanded threat model"],
  feedback_addressed: "yes" as const,
};

// -- Shared tail mocks (ADRs through end) for scenarios without doc/final issues --
function sharedTailMocks() {
  return {
    "create-adrs": adrsMock,
    "quality-attributes": qualityAttributesMock,
    "crosscutting-concerns": crosscuttingMock,
    "assemble-documentation": assembleDocsMock,
    "review-documentation": docReviewNoIssues,
    "present-final": finalApproved,
  };
}

describe("architecture-design-flow Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = {
        id: `moira/${workflow.slug || "architecture-design-flow"}`,
        ...workflow,
      };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have intentional cycles (fix loops)", () => {
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
        // Scenario A: New project happy path
        {
          name: "New project - happy path",
          description: "New project design with no issues at any gate",
          expect: { status: "completed" },
          mockInputs: {
            "gather-context": newProjectContext,
            "a-requirements": requirementsMock,
            "a-domain-analysis": domainAnalysisMock,
            "a-system-context": systemContextMock,
            "a-detailed-design": detailedDesignMock,
            "confirm-scope": scopeApproved,
            "subagent-review": reviewNoIssues,
            ...sharedTailMocks(),
          },
        },

        // Scenario B: Existing project happy path
        {
          name: "Existing project - happy path",
          description: "Existing project analysis with no issues at any gate",
          expect: { status: "completed" },
          mockInputs: {
            "gather-context": existingProjectContext,
            "b-project-scan": projectScanMock,
            "b-reverse-engineer": reverseEngineerMock,
            "b-current-state": currentStateMock,
            "b-improvements": improvementsMock,
            "confirm-scope": scopeApproved,
            "subagent-review": reviewNoIssues,
            ...sharedTailMocks(),
          },
        },

        // Scenario C: Scope rejected then approved
        {
          name: "Scope rejected then approved",
          description: "User rejects scope, agent refines, user approves second time",
          expect: { status: "completed" },
          mockInputs: {
            "gather-context": newProjectContext,
            "a-requirements": requirementsMock,
            "a-domain-analysis": domainAnalysisMock,
            "a-system-context": systemContextMock,
            "a-detailed-design": detailedDesignMock,
            "confirm-scope": [scopeRejected, scopeApproved],
            "refine-scope": refineScopeMock,
            "subagent-review": reviewNoIssues,
            ...sharedTailMocks(),
          },
        },

        // Scenario D: Architecture review finds issues, fix under limit
        {
          name: "Architecture review issues - fix under limit",
          description: "Subagent review finds issues, fix applied, second review passes",
          expect: { status: "completed" },
          mockInputs: {
            "gather-context": newProjectContext,
            "a-requirements": requirementsMock,
            "a-domain-analysis": domainAnalysisMock,
            "a-system-context": systemContextMock,
            "a-detailed-design": detailedDesignMock,
            "confirm-scope": scopeApproved,
            "subagent-review": [reviewWithIssues, reviewNoIssues],
            "fix-architecture": fixArchitectureMock,
            ...sharedTailMocks(),
          },
        },

        // Scenario E: Architecture fix cycle hits limit
        {
          name: "Architecture fix cycle hits limit",
          description: "Fix iterations reach max, escalates to confirm-scope, then passes review",
          expect: { status: "completed" },
          mockInputs: {
            "gather-context": newProjectContext,
            "a-requirements": requirementsMock,
            "a-domain-analysis": domainAnalysisMock,
            "a-system-context": systemContextMock,
            "a-detailed-design": detailedDesignMock,
            "confirm-scope": [scopeApproved, scopeApproved],
            "subagent-review": [
              reviewWithIssues,
              reviewWithIssues,
              reviewWithIssues,
              reviewNoIssues,
            ],
            "fix-architecture": [fixArchitectureMock, fixArchitectureMock, fixArchitectureMock],
            ...sharedTailMocks(),
          },
        },

        // Scenario F: Documentation review finds issues
        {
          name: "Documentation review finds issues",
          description: "Doc review finds major issue, fix applied, second review passes",
          expect: { status: "completed" },
          mockInputs: {
            "gather-context": existingProjectContext,
            "b-project-scan": projectScanMock,
            "b-reverse-engineer": reverseEngineerMock,
            "b-current-state": currentStateMock,
            "b-improvements": improvementsMock,
            "confirm-scope": scopeApproved,
            "subagent-review": reviewNoIssues,
            "create-adrs": adrsMock,
            "quality-attributes": qualityAttributesMock,
            "crosscutting-concerns": crosscuttingMock,
            "assemble-documentation": assembleDocsMock,
            "review-documentation": [docReviewWithIssues, docReviewNoIssues],
            "fix-documentation": fixDocsMock,
            "present-final": finalApproved,
          },
        },

        // Scenario G: Final approval rejected
        {
          name: "Final approval rejected then approved",
          description: "User rejects final output, docs fixed, re-reviewed, then approved",
          expect: { status: "completed" },
          mockInputs: {
            "gather-context": newProjectContext,
            "a-requirements": requirementsMock,
            "a-domain-analysis": domainAnalysisMock,
            "a-system-context": systemContextMock,
            "a-detailed-design": detailedDesignMock,
            "confirm-scope": scopeApproved,
            "subagent-review": reviewNoIssues,
            "create-adrs": adrsMock,
            "quality-attributes": qualityAttributesMock,
            "crosscutting-concerns": crosscuttingMock,
            "assemble-documentation": assembleDocsMock,
            "review-documentation": docReviewNoIssues,
            "fix-documentation": fixDocsMock,
            "present-final": [finalRejected, finalApproved],
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
