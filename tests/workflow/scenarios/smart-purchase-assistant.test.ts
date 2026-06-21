/**
 * smart-purchase-assistant Scenario Tests
 *
 * Purchase assistant workflow for product recommendations with notes persistence and artifacts upload.
 * Version: 3.0.1
 *
 * Workflow structure (22 nodes):
 * 1. start → 2. check-agent-capabilities → 3. analyze-user-needs → 4. write-note-01 (auto) →
 * 5. research-product-category → 6. write-note-02 (auto) → 7. determine-search-sources →
 * 8. write-note-03 (auto) → 9. search-and-analyze → 10. write-note-04 (auto) →
 * 11. deep-analysis → 12. write-note-05 (auto) → 13. analyze-purchase-conditions →
 * 14. write-note-06 (auto) → 15. generate-recommendations → 16. write-note-07 (auto) →
 * 17. check-can-create-files (condition)
 *
 * Branch 1 (can_create_files=true):
 * → 18. generate-html-report → 19. upload-via-token → 21. telegram-notification → 22. end
 *
 * Branch 2 (can_create_files=false):
 * → 20. generate-and-upload-report → 21. telegram-notification → 22. end
 *
 * Coverage target: 100% nodes (22), 100% branches (2)
 */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import * as path from "path";
import {
  runScenario,
  type TestScenario,
  type ScenarioResult,
  TEST_USER_ID,
} from "../../helpers/scenario-runner.js";
import { calculateCoverage, formatCoverageReport } from "../../helpers/coverage-calculator.js";
import { GraphValidator, detectCycles } from "@mcp-moira/workflow-engine";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { closeDatabase, getDatabase } from "@mcp-moira/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@mcp-moira/shared";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");
// Use scenario-runner's TEST_USER_ID for database operations
// to match what runScenario uses internally
const TEST_RUN_ID = Date.now().toString(36);
const TEST_USER_HANDLE = `test-user-${TEST_RUN_ID}`;

function loadProductionWorkflow(): WorkflowGraph {
  return findSystemCatalogEntry("smart-purchase-assistant", "public")!.graph as WorkflowGraph;
}

describe("smart-purchase-assistant Scenarios", () => {
  let workflow: WorkflowGraph;
  let originalDbPath: string | undefined;

  beforeAll(() => {
    // Set DB_PATH to :memory: for tests (write-note nodes need database)
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = ":memory:";

    // Close any existing database connection (force singleton to reinitialize)
    closeDatabase();

    // Initialize in-memory database with schema
    const db = getDatabase();
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    // Create test user (required for write-note nodes with foreign key constraints)
    // Use onConflictDoNothing to handle case when user already exists (shared DB across tests)
    const now = new Date().toISOString();
    db.insert(schema.user)
      .values({
        id: TEST_USER_ID,
        email: "workflow-test@example.com",
        name: "Test User",
        handle: TEST_USER_HANDLE,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();

    workflow = loadProductionWorkflow();
  });

  afterAll(() => {
    // Close database connection
    closeDatabase();

    // Restore original DB_PATH
    if (originalDbPath !== undefined) {
      process.env.DB_PATH = originalDbPath;
    } else {
      delete process.env.DB_PATH;
    }
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "smart-purchase-assistant"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have no cycles (linear workflow)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles).toHaveLength(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(22);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        // Scenario 1: can_create_files=true path (generate-html-report → upload-via-token)
        {
          name: "Complete purchase assistant workflow with file creation",
          description: "Full product research with HTML report generation and token upload",
          expect: { status: "completed" },
          mockInputs: {
            "check-agent-capabilities": {
              can_create_files: true,
              can_create_artifacts: true,
            },
            "analyze-user-needs": {
              product_type: "Laptop",
              budget_min: 1000,
              budget_max: 1500,
              use_case: "Software development",
              requirements: ["Performance", "Battery life", "Display quality"],
            },
            "research-product-category": {
              product_types: ["Ultrabook", "Mobile Workstation"],
              key_parameters: ["CPU performance", "RAM", "SSD size", "Display resolution"],
              alternatives: ["Desktop + tablet combo"],
              technology_trends: ["Apple Silicon", "DDR5 RAM"],
              device_types: [
                {
                  name: "Ultrabook",
                  principle: "Thin and light laptop optimized for portability and battery life",
                  price_range: "800-2000 USD",
                  best_for: "Mobile professionals who prioritize portability",
                },
                {
                  name: "Mobile Workstation",
                  principle: "High-performance laptop with dedicated GPU for demanding tasks",
                  price_range: "1500-4000 USD",
                  best_for: "Developers and content creators needing raw power",
                },
              ],
              use_cases: [
                {
                  scenario: "Software development on the go",
                  recommended_type: "Ultrabook",
                  priority_params: ["CPU performance", "RAM", "Battery life"],
                },
                {
                  scenario: "Heavy compilation and containerized development",
                  recommended_type: "Mobile Workstation",
                  priority_params: ["CPU cores", "RAM 32GB+", "SSD speed"],
                },
              ],
              price_segments: {
                budget: "500-800 USD: basic specs, older gen CPU, 8GB RAM",
                mid_range: "800-1500 USD: current gen CPU, 16GB RAM, good display",
                premium: "1500-3000+ USD: top CPU, 32GB+ RAM, premium build quality",
              },
              buyer_checklist: [
                {
                  parameter: "CPU generation and cores",
                  why_matters: "Directly affects compilation speed and multitasking",
                  good_values: "Latest gen, 8+ cores",
                  bad_values: "2+ gen old, 4 cores",
                },
                {
                  parameter: "RAM amount",
                  why_matters: "IDEs, Docker, browsers consume significant memory",
                  good_values: "16GB minimum, 32GB ideal",
                  bad_values: "8GB or less",
                },
                {
                  parameter: "SSD speed and capacity",
                  why_matters: "Affects project load times and build speeds",
                  good_values: "NVMe 512GB+",
                  bad_values: "SATA SSD or HDD",
                },
                {
                  parameter: "Display quality",
                  why_matters: "Long coding sessions require good visibility",
                  good_values: "IPS/OLED, 2K+, 300nit+",
                  bad_values: "TN panel, 1080p, dim",
                },
                {
                  parameter: "Battery life",
                  why_matters: "Productivity away from power outlets",
                  good_values: "8+ hours real-world",
                  bad_values: "Under 5 hours",
                },
                {
                  parameter: "Keyboard quality",
                  why_matters: "Primary input device for developers",
                  good_values: "1.5mm+ travel, good feedback",
                  bad_values: "Shallow, mushy keys",
                },
                {
                  parameter: "Weight",
                  why_matters: "Daily carry comfort",
                  good_values: "Under 1.8kg",
                  bad_values: "Over 2.5kg",
                },
                {
                  parameter: "Port selection",
                  why_matters: "Connecting peripherals and displays",
                  good_values: "USB-C/Thunderbolt, HDMI, USB-A",
                  bad_values: "Only 1-2 USB-C ports",
                },
              ],
            },
            "determine-search-sources": {
              marketplaces: ["Amazon", "Best Buy", "B&H Photo"],
              specialized_stores: ["Micro Center"],
              manufacturers: ["Apple", "Dell", "Lenovo"],
              search_priority: ["marketplaces", "manufacturers"],
            },
            "search-and-analyze": {
              candidates: [
                {
                  name: "MacBook Pro 14",
                  price: 1399,
                  source: "Amazon",
                  product_url: "https://amazon.com/macbook-pro-14",
                },
                {
                  name: "Dell XPS 15",
                  price: 1299,
                  source: "Best Buy",
                  product_url: "https://bestbuy.com/dell-xps-15",
                },
                {
                  name: "Lenovo ThinkPad X1",
                  price: 1199,
                  source: "Lenovo",
                  product_url: "https://lenovo.com/thinkpad-x1",
                },
              ],
              search_summary: "Found 25 products, filtered to 8 matching criteria",
            },
            "deep-analysis": {
              detailed_analysis: [
                {
                  product_name: "MacBook Pro 14",
                  pros: ["Best performance", "Great battery"],
                  cons: ["High price"],
                  rating_score: 9,
                  review_count: 2500,
                  verified_purchase_percent: 85,
                  latest_review_date: "2025-01-15",
                  common_complaints: ["Price"],
                  common_praises: ["Performance", "Battery life"],
                  review_summary: "Highly rated by verified buyers",
                  expert_opinion: "Top choice for developers",
                },
                {
                  product_name: "Dell XPS 15",
                  pros: ["Good value", "Windows compatible"],
                  cons: ["Shorter battery"],
                  rating_score: 8,
                  review_count: 1800,
                  verified_purchase_percent: 78,
                  latest_review_date: "2025-01-10",
                  common_complaints: ["Battery life"],
                  common_praises: ["Display", "Build quality"],
                  review_summary: "Solid Windows alternative",
                  expert_opinion: "Best value option",
                },
                {
                  product_name: "ThinkPad X1",
                  pros: ["Business features", "Keyboard"],
                  cons: ["Average battery"],
                  rating_score: 7,
                  review_count: 1200,
                  verified_purchase_percent: 72,
                  latest_review_date: "2025-01-05",
                  common_complaints: ["Battery", "Price"],
                  common_praises: ["Keyboard", "Durability"],
                  review_summary: "Business-focused option",
                  expert_opinion: "Best keyboard",
                },
              ],
            },
            "analyze-purchase-conditions": {
              purchase_analysis: [
                {
                  product_name: "MacBook Pro 14",
                  total_cost: 1399,
                  warranty: "1 year",
                  availability: "In stock",
                  delivery_time: "2-3 days",
                  return_policy: "14 days",
                },
                {
                  product_name: "Dell XPS 15",
                  total_cost: 1169,
                  current_offers: ["10% off with code SAVE10"],
                  availability: "In stock",
                  delivery_time: "1-2 days",
                  return_policy: "30 days",
                },
              ],
            },
            "generate-recommendations": {
              top_recommendations: [
                {
                  rank: 1,
                  product_name: "MacBook Pro 14",
                  why_recommended: "Best overall for dev",
                  total_cost: 1399,
                  product_url: "https://amazon.com/macbook-pro-14",
                  best_store_url: "https://amazon.com/macbook-pro-14",
                  key_advantages: ["Performance", "Battery"],
                  best_for: "Professional development",
                },
                {
                  rank: 2,
                  product_name: "Dell XPS 15",
                  why_recommended: "Best value",
                  total_cost: 1169,
                  product_url: "https://bestbuy.com/dell-xps-15",
                  best_store_url: "https://bestbuy.com/dell-xps-15",
                  key_advantages: ["Value", "Display"],
                  best_for: "Budget-conscious developers",
                },
                {
                  rank: 3,
                  product_name: "ThinkPad X1",
                  why_recommended: "Best keyboard",
                  total_cost: 1199,
                  product_url: "https://lenovo.com/thinkpad-x1",
                  best_store_url: "https://lenovo.com/thinkpad-x1",
                  key_advantages: ["Keyboard", "Durability"],
                  best_for: "Business users",
                },
                {
                  rank: 4,
                  product_name: "ASUS ZenBook 14",
                  why_recommended: "Best ultraportable",
                  total_cost: 999,
                  product_url: "https://amazon.com/zenbook-14",
                  best_store_url: "https://amazon.com/zenbook-14",
                  key_advantages: ["Lightweight", "Price"],
                  best_for: "Students and travelers",
                },
                {
                  rank: 5,
                  product_name: "HP Spectre x360",
                  why_recommended: "Best 2-in-1",
                  total_cost: 1299,
                  product_url: "https://hp.com/spectre-x360",
                  best_store_url: "https://hp.com/spectre-x360",
                  key_advantages: ["Versatility", "Design"],
                  best_for: "Creative professionals",
                },
              ],
              comparison_table: "Performance | Value | Battery comparison table",
              purchase_plan: [
                "Check MacBook Pro 14 on Amazon",
                "Apply AppleCare+",
                "Complete purchase",
              ],
              alternative_options: ["Dell XPS 15 for Windows preference"],
              buyer_guide: {
                product_types_overview: [
                  {
                    type_name: "Ultrabook",
                    description:
                      "Thin and light laptops optimized for portability. Typically 13-14 inch screens with long battery life.",
                    pros: ["Lightweight", "Long battery", "Portable"],
                    cons: ["Limited GPU", "Fewer ports"],
                    best_for: "Travelers and students who prioritize mobility",
                  },
                  {
                    type_name: "Mobile Workstation",
                    description:
                      "Powerful laptops for professional workloads. Dedicated GPU and high-performance CPUs.",
                    pros: ["High performance", "Dedicated GPU", "More RAM"],
                    cons: ["Heavy", "Shorter battery life"],
                    best_for: "Developers and creatives needing raw compute power",
                  },
                ],
                selection_checklist: [
                  "Determine primary use case",
                  "Set budget range",
                  "Check CPU benchmarks",
                  "Verify RAM expandability",
                ],
                decision_matrix: [
                  { if_you_value: "Portability", choose: "Ultrabook" },
                  { if_you_value: "Raw performance", choose: "Mobile Workstation" },
                  { if_you_value: "Best keyboard", choose: "ThinkPad X1" },
                ],
                common_mistakes: [
                  {
                    mistake: "Buying based on specs alone without checking thermals",
                    how_to_avoid: "Read reviews that include thermal testing under sustained load",
                  },
                  {
                    mistake: "Ignoring keyboard quality for a coding laptop",
                    how_to_avoid: "Try keyboards in person or read detailed keyboard reviews",
                  },
                  {
                    mistake: "Overlooking display quality",
                    how_to_avoid: "Check color accuracy and brightness specs for your use case",
                  },
                ],
              },
            },
            "generate-html-report": {
              report_file_path: "/tmp/laptop-recommendations.html",
              report_generated: true,
            },
            "upload-via-token": {
              report_url: "https://example.com/artifacts/abc123",
              uploaded: true,
            },
          },
        },

        // Scenario 2: can_create_files=false path (generate-and-upload-report)
        {
          name: "Purchase assistant without file creation capability",
          description: "Product recommendation with direct artifact upload",
          expect: { status: "completed" },
          mockInputs: {
            "check-agent-capabilities": {
              can_create_files: false,
              can_create_artifacts: false,
            },
            "analyze-user-needs": {
              product_type: "Wireless mouse",
              budget_max: 100,
              use_case: "Daily office work",
            },
            "research-product-category": {
              product_types: ["Ergonomic mouse", "Standard mouse"],
              key_parameters: ["Ergonomics", "Battery life", "DPI"],
              device_types: [
                {
                  name: "Ergonomic mouse",
                  principle: "Shaped to reduce wrist strain during extended use",
                  price_range: "30-120 USD",
                  best_for: "Office workers with long computer sessions",
                },
                {
                  name: "Standard mouse",
                  principle: "Traditional symmetric design for general use",
                  price_range: "10-50 USD",
                  best_for: "Casual users and budget-conscious buyers",
                },
              ],
              use_cases: [
                {
                  scenario: "Daily office work 8+ hours",
                  recommended_type: "Ergonomic mouse",
                  priority_params: ["Ergonomics", "Battery life", "Wireless reliability"],
                },
              ],
              price_segments: {
                budget: "10-30 USD: basic wireless, no ergonomic features",
                mid_range: "30-70 USD: ergonomic design, good battery, multi-device",
                premium: "70-150 USD: premium ergonomics, customizable buttons, long battery",
              },
              buyer_checklist: [
                {
                  parameter: "Ergonomic design",
                  why_matters: "Prevents RSI and wrist pain",
                  good_values: "Vertical or sculpted design",
                  bad_values: "Flat symmetric shape",
                },
                {
                  parameter: "Battery life",
                  why_matters: "Reduces charging interruptions",
                  good_values: "30+ days on single charge",
                  bad_values: "Under 7 days",
                },
                {
                  parameter: "DPI range",
                  why_matters: "Cursor precision for different tasks",
                  good_values: "1000-4000 adjustable",
                  bad_values: "Fixed low DPI",
                },
                {
                  parameter: "Connectivity",
                  why_matters: "Compatibility with multiple devices",
                  good_values: "Bluetooth + USB receiver",
                  bad_values: "Wired only or single device",
                },
                {
                  parameter: "Weight",
                  why_matters: "Comfort during extended use",
                  good_values: "80-120g",
                  bad_values: "Over 150g",
                },
                {
                  parameter: "Scroll wheel quality",
                  why_matters: "Smooth scrolling for documents and code",
                  good_values: "Metal wheel, smooth/ratchet modes",
                  bad_values: "Cheap plastic, no modes",
                },
                {
                  parameter: "Side buttons",
                  why_matters: "Productivity shortcuts",
                  good_values: "2+ programmable buttons",
                  bad_values: "No side buttons",
                },
                {
                  parameter: "Multi-device support",
                  why_matters: "Switch between laptop and desktop",
                  good_values: "2-3 device pairing",
                  bad_values: "Single device only",
                },
              ],
            },
            "determine-search-sources": {
              marketplaces: ["Amazon"],
              search_priority: ["marketplaces"],
            },
            "search-and-analyze": {
              candidates: [
                {
                  name: "Logitech MX Master 3",
                  price: 79,
                  source: "Amazon",
                  product_url: "https://amazon.com/mx-master-3",
                },
              ],
              search_summary: "Found 10 products, filtered to 3",
            },
            "deep-analysis": {
              detailed_analysis: [
                {
                  product_name: "Logitech MX Master 3",
                  pros: ["Ergonomic", "70 day battery"],
                  cons: ["Premium price"],
                  rating_score: 9,
                  review_count: 5000,
                  verified_purchase_percent: 90,
                  latest_review_date: "2025-01-20",
                  common_complaints: ["Price"],
                  common_praises: ["Comfort", "Battery"],
                  review_summary: "Highly recommended by users",
                  expert_opinion: "Best ergonomic mouse",
                },
              ],
            },
            "analyze-purchase-conditions": {
              purchase_analysis: [
                {
                  product_name: "Logitech MX Master 3",
                  total_cost: 79,
                  availability: "In stock",
                  delivery_time: "1 day",
                },
              ],
            },
            "generate-recommendations": {
              top_recommendations: [
                {
                  rank: 1,
                  product_name: "Logitech MX Master 3",
                  why_recommended: "Best ergonomic",
                  total_cost: 79,
                  product_url: "https://amazon.com/mx-master-3",
                  best_store_url: "https://amazon.com/mx-master-3",
                  key_advantages: ["Ergonomics", "Battery"],
                  best_for: "Daily office work",
                },
                {
                  rank: 2,
                  product_name: "Razer DeathAdder V3",
                  why_recommended: "Best precision",
                  total_cost: 69,
                  product_url: "https://amazon.com/deathadder-v3",
                  best_store_url: "https://amazon.com/deathadder-v3",
                  key_advantages: ["Precision", "Lightweight"],
                  best_for: "Precision tasks",
                },
                {
                  rank: 3,
                  product_name: "Logitech G305",
                  why_recommended: "Best budget wireless",
                  total_cost: 39,
                  product_url: "https://amazon.com/g305",
                  best_store_url: "https://amazon.com/g305",
                  key_advantages: ["Price", "Wireless"],
                  best_for: "Budget-conscious users",
                },
                {
                  rank: 4,
                  product_name: "Microsoft Arc Mouse",
                  why_recommended: "Most portable",
                  total_cost: 59,
                  product_url: "https://amazon.com/arc-mouse",
                  best_store_url: "https://amazon.com/arc-mouse",
                  key_advantages: ["Portability", "Design"],
                  best_for: "Travelers",
                },
                {
                  rank: 5,
                  product_name: "Logitech Pebble 2",
                  why_recommended: "Quietest option",
                  total_cost: 29,
                  product_url: "https://amazon.com/pebble-2",
                  best_store_url: "https://amazon.com/pebble-2",
                  key_advantages: ["Silent", "Compact"],
                  best_for: "Quiet office environments",
                },
              ],
              comparison_table: "Simple comparison",
              purchase_plan: ["Buy from Amazon"],
              buyer_guide: {
                product_types_overview: [
                  {
                    type_name: "Ergonomic Mouse",
                    description:
                      "Mice designed to reduce hand strain during extended use. Vertical or contoured shapes.",
                    pros: ["Reduces strain", "Comfortable for long sessions"],
                    cons: ["Higher price", "Larger size"],
                    best_for: "Users working 4+ hours daily at a computer",
                  },
                  {
                    type_name: "Standard Mouse",
                    description:
                      "Traditional flat mice suitable for general use. Wide range of prices and features.",
                    pros: ["Affordable", "Portable", "Wide selection"],
                    cons: ["May cause strain over time"],
                    best_for: "Casual users and those on a budget",
                  },
                ],
                selection_checklist: [
                  "Assess daily usage hours",
                  "Check hand size compatibility",
                  "Verify device connectivity needs",
                ],
                decision_matrix: [
                  { if_you_value: "Comfort for long hours", choose: "Ergonomic mouse" },
                  { if_you_value: "Budget", choose: "Standard wireless mouse" },
                  { if_you_value: "Portability", choose: "Compact travel mouse" },
                ],
                common_mistakes: [
                  {
                    mistake: "Choosing based on price alone ignoring ergonomics",
                    how_to_avoid:
                      "Consider daily usage hours — ergonomic mice pay for themselves in comfort",
                  },
                  {
                    mistake: "Not testing grip style compatibility",
                    how_to_avoid:
                      "Know your grip style (palm, claw, fingertip) and check mouse shape compatibility",
                  },
                  {
                    mistake: "Ignoring DPI needs for your workflow",
                    how_to_avoid: "Match DPI to screen resolution and task precision requirements",
                  },
                ],
              },
            },
            "generate-and-upload-report": {
              report_url: "https://example.com/artifacts/def456",
              uploaded: true,
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
