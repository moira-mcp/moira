/**
 * data-analysis Scenario Tests
 *
 * Data analysis workflow with multiple validation loops and branching.
 * Coverage target: 100% nodes (27), 100% branches
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
  return findSystemCatalogEntry("data-analysis", "public")!.graph as WorkflowGraph;
}

describe("data-analysis Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "data-analysis"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected cycles (validation loops)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(33);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        // Scenario 1: Happy path with inline data
        {
          name: "Happy path - inline data source",
          description: "All validations pass, inline data collection",
          expect: { status: "completed" },
          mockInputs: {
            "get-context": {
              business_question: "What are top-performing products by region?",
              context: "Sales performance analysis for Q4",
              data_sources: "sales_database, inventory_system",
              data_source_type: "inline",
              audience: "Sales leadership team",
            },
            "define-problem": {
              research_question: "Identify top-performing products by region",
              hypotheses: "West region leads in product A sales, Q4 shows seasonal trends",
              success_criteria: "Clear ranking of products by region",
              scope: "Q4 2024 sales data",
              deliverables: "Analysis report, Recommendations",
            },
            "approve-problem": { approved: "yes" },
            "collect-data-inline": {
              datasets_info: "Sales data from internal system, 10000 rows",
              quality_observations: "Data looks clean, no major issues",
              data_volume: "10000 rows",
            },
            "prepare-data": {
              missing_values_strategy: "Imputation with mean values",
              transformations_applied: "Normalized revenue, Date parsing applied",
              final_dataset_info: "Cleaned dataset with 9500 rows ready for analysis",
            },
            "check-data-quality": { quality_passed: "yes" },
            "explore-data": {
              key_statistics: "Mean revenue: 1500, Std dev: 500, Median: 1400",
              patterns_found: "Seasonality in Q4, Regional variance observed",
              preliminary_insights: "West leads in revenue, strong Q4 performance",
            },
            "check-eda": { eda_complete: "yes" },
            "find-insights": {
              hypotheses_results: "West leads hypothesis confirmed with 95% confidence",
              answer_to_research_question:
                "Product A leads in West region with 30% above average sales",
              key_insights: "West region 30% above average, Q4 spike pattern identified",
              limitations: "Only Q4 data analyzed, no YoY comparison",
              recommendations: "Focus marketing on West for Product A, expand Q4 campaigns",
            },
            visualize: {
              visualizations_created: "Bar chart by region, Time series analysis, Heatmap",
              key_visual_insights: "Clear West dominance in chart, seasonal patterns visible",
            },
            conclude: {
              executive_summary: "West region outperforms in Product A sales by 30%",
              key_findings: "West leads by 30%, Q4 shows seasonal spike pattern",
              recommendations: "Increase West region marketing budget significantly",
              limitations_caveats: "Limited to Q4 data, needs validation",
              next_steps: "Validate findings with Q1 data when available",
            },
            "approve-conclusions": { conclusions_approved: "yes" },
            finalize: {
              deliverables_prepared: "Analysis report, Dashboard completed",
              artifacts_saved: "report.pdf, dashboard.html",
            },
          },
        },

        // Scenario 2: Happy path with external data
        {
          name: "Happy path - external data source",
          description: "All validations pass, external data collection",
          expect: { status: "completed" },
          mockInputs: {
            "get-context": {
              business_question: "What predicts customer churn?",
              context: "Customer retention analysis",
              data_sources: "CRM and usage_logs exports",
              data_source_type: "file",
              audience: "Customer success team",
            },
            "define-problem": {
              research_question: "Identify churn predictors",
              hypotheses: "Low engagement predicts churn, usage patterns correlate",
              success_criteria: "Model with 80% accuracy",
              scope: "Last 12 months customer data",
              deliverables: "Churn prediction model, Documentation",
            },
            "approve-problem": { approved: "yes" },
            "collect-data": {
              datasets_info: "CRM data exported to CSV, 50000 customers",
              quality_observations: "Some missing values in engagement metrics found",
              data_volume: "50000 customers",
            },
            "prepare-data": {
              missing_values_strategy: "Drop rows with >50% missing values",
              transformations_applied: "Feature encoding, Scaling, Normalization",
              final_dataset_info: "48000 customer records cleaned and ready",
            },
            "check-data-quality": { quality_passed: "yes" },
            "explore-data": {
              key_statistics: "Churn rate: 15%, Mean engagement: 0.65, Std: 0.25",
              patterns_found: "Usage decline before churn, weekly patterns",
              preliminary_insights: "2-week usage drop signals churn with high probability",
            },
            "check-eda": { eda_complete: "yes" },
            "find-insights": {
              hypotheses_results: "Low engagement hypothesis confirmed with 85% confidence",
              answer_to_research_question: "Usage decline is primary predictor with 80% accuracy",
              key_insights: "2-week usage drop equals 80% churn probability",
              limitations: "Model trained on historical data only",
              recommendations: "Implement engagement alerts for at-risk users",
            },
            visualize: {
              visualizations_created: "Churn funnel, Feature importance chart, Timeline",
              key_visual_insights: "Clear correlation visible between usage and churn",
            },
            conclude: {
              executive_summary: "Usage decline predicts churn with 80% accuracy",
              key_findings: "2-week usage drop is the key signal for churn prediction",
              recommendations: "Automated engagement monitoring system required",
              limitations_caveats: "Requires ongoing model updates and retraining",
              next_steps: "Implement real-time monitoring dashboard",
            },
            "approve-conclusions": { conclusions_approved: "yes" },
            finalize: {
              deliverables_prepared: "Model deployed, Documentation complete",
            },
          },
        },

        // Scenario 3: Problem not approved - revision loop
        {
          name: "Problem not approved - needs revision",
          description: "Initial problem statement rejected, revised",
          expect: { status: "completed" },
          mockInputs: {
            "get-context": {
              business_question: "Improve conversion",
              context: "Funnel analysis",
              data_sources: "analytics database",
              data_source_type: "inline",
              audience: "Product team",
            },
            "define-problem": [
              {
                research_question: "Vague question about conversions",
                hypotheses: "Need more specific hypotheses to be defined",
                success_criteria: "Unknown criteria needs clarification",
                scope: "Unclear scope needs definition",
                deliverables: "Unclear deliverables",
              },
              {
                research_question: "Identify funnel drop-off points",
                hypotheses: "Checkout is primary drop-off point, mobile worse",
                success_criteria: "Clear drop-off analysis with percentages",
                scope: "Last month's funnel data",
                deliverables: "Funnel report with recommendations",
              },
            ],
            "approve-problem": [{ approved: "no", feedback: "Too vague" }, { approved: "yes" }],
            "collect-data-inline": {
              datasets_info: "Funnel events from analytics, 10000 users",
              quality_observations: "Good quality data observed",
            },
            "prepare-data": {
              missing_values_strategy: "None needed for this dataset",
              transformations_applied: "Event aggregation, Session grouping",
              final_dataset_info: "Clean funnel data ready for analysis",
            },
            "check-data-quality": { quality_passed: "yes" },
            "explore-data": {
              key_statistics: "Total users: 10000, Conversions: 500, Rate: 5%",
              patterns_found: "50% drop at checkout step identified",
              preliminary_insights: "Checkout is main friction point for users",
            },
            "check-eda": { eda_complete: "yes" },
            "find-insights": {
              hypotheses_results: "Checkout drop hypothesis confirmed with data",
              answer_to_research_question: "Checkout causes 50% drop in conversions",
              key_insights: "Simplify checkout to improve conversion rates",
              limitations: "Single month data analyzed only",
              recommendations: "Reduce checkout steps from 5 to 3",
            },
            visualize: {
              visualizations_created: "Funnel chart, Drop-off heatmap, Step analysis",
              key_visual_insights: "Clear drop visible at checkout step",
            },
            conclude: {
              executive_summary: "Checkout is primary friction point causing 50% drop",
              key_findings: "50% drop at checkout, mobile 60% drop",
              recommendations: "Simplify checkout flow and add guest checkout",
              limitations_caveats: "Limited timeframe of one month",
              next_steps: "A/B test simplified checkout flow",
            },
            "approve-conclusions": { conclusions_approved: "yes" },
            finalize: { deliverables_prepared: "Report complete with recommendations" },
          },
        },

        // Scenario 4: Data quality fails
        {
          name: "Data quality fails - re-preparation needed",
          description: "Initial data quality check fails, data re-prepared",
          expect: { status: "completed" },
          mockInputs: {
            "get-context": {
              business_question: "Revenue forecast",
              context: "Financial planning",
              data_sources: "finance database",
              data_source_type: "inline",
              audience: "Finance team",
            },
            "define-problem": {
              research_question: "Predict next quarter revenue",
              hypotheses: "Growth will continue based on historical trends",
              success_criteria: "Forecast with 90% confidence interval",
              scope: "Last 3 years data",
              deliverables: "Revenue forecast report",
            },
            "approve-problem": { approved: "yes" },
            "collect-data-inline": {
              datasets_info: "Revenue data from finance system, 3 years",
              quality_observations: "Some nulls detected in data",
            },
            "prepare-data": [
              {
                missing_values_strategy: "Initial attempt with basic imputation",
                transformations_applied: "Basic cleaning, Date formatting",
                final_dataset_info: "500 rows cleaned initially",
              },
              {
                missing_values_strategy: "Advanced imputation with interpolation",
                transformations_applied: "Full cleaning pipeline, Outlier removal",
                final_dataset_info: "2000 rows fully cleaned and validated",
              },
            ],
            "check-data-quality": [
              { quality_passed: "no", issues_found: "Too many nulls, Inconsistent dates" },
              { quality_passed: "yes" },
            ],
            "explore-data": {
              key_statistics: "Revenue trend: positive, Mean growth: 18%, Std: 5%",
              patterns_found: "Steady growth pattern with seasonality",
              preliminary_insights: "20% YoY growth observed consistently",
            },
            "check-eda": { eda_complete: "yes" },
            "find-insights": {
              hypotheses_results: "Growth continues hypothesis confirmed with data",
              answer_to_research_question: "Expect 15-20% growth next quarter based on trends",
              key_insights: "Growth trend stable at 18% average annually",
              limitations: "External factors not modeled in forecast",
              recommendations: "Continue current strategy with growth investment",
            },
            visualize: {
              visualizations_created: "Trend line, Forecast chart, Confidence intervals",
              key_visual_insights: "Clear upward trend with narrow confidence band",
            },
            conclude: {
              executive_summary: "15-20% growth expected based on analysis",
              key_findings: "Stable growth pattern at 18% annually",
              recommendations: "Maintain growth investments at current levels",
              limitations_caveats: "Market conditions may change forecast",
              next_steps: "Review forecast quarterly with actual data",
            },
            "approve-conclusions": { conclusions_approved: "yes" },
            finalize: { deliverables_prepared: "Forecast report complete" },
          },
        },

        // Scenario 5: EDA incomplete
        {
          name: "EDA incomplete - more exploration needed",
          description: "Initial EDA not complete, additional exploration done",
          expect: { status: "completed" },
          mockInputs: {
            "get-context": {
              business_question: "User behavior patterns",
              context: "Product analytics",
              data_sources: "event log files",
              data_source_type: "file",
              audience: "Product managers",
            },
            "define-problem": {
              research_question: "Identify user behavior patterns",
              hypotheses: "Power users have distinct patterns from casual users",
              success_criteria: "Clear user segments identified",
              scope: "Last 3 months",
              deliverables: "Segmentation analysis report",
            },
            "approve-problem": { approved: "yes" },
            "collect-data": {
              datasets_info: "Event logs from analytics, 10000 users",
              quality_observations: "Good quality data observed",
              data_volume: "10000 users",
            },
            "prepare-data": {
              missing_values_strategy: "Drop incomplete sessions from dataset",
              transformations_applied: "Session aggregation, Feature extraction",
              final_dataset_info: "9500 user records cleaned and ready",
            },
            "check-data-quality": { quality_passed: "yes" },
            "explore-data": [
              {
                key_statistics: "Average sessions: 5, Users: 10000, Active: 60%",
                patterns_found: "Initial patterns emerging in data",
                preliminary_insights: "Some clustering visible in usage data",
              },
              {
                key_statistics: "Average sessions: 5, Segments: 4, Power users: 15%",
                patterns_found: "Clear 4 segments, Feature usage patterns identified",
                preliminary_insights: "Power users focus on 3 features primarily",
              },
            ],
            "check-eda": [
              { eda_complete: "no", gaps_found: "Need feature correlations" },
              { eda_complete: "yes" },
            ],
            "find-insights": {
              hypotheses_results: "Power users distinct hypothesis confirmed with data",
              answer_to_research_question: "4 clear user segments identified in analysis",
              key_insights: "Power users use 3 core features intensively",
              limitations: "Segment boundaries fuzzy in edge cases",
              recommendations: "Enhance core 3 features for power users",
            },
            visualize: {
              visualizations_created: "Cluster plot, Feature usage heatmap, Timeline",
              key_visual_insights: "Segments clearly visible in cluster visualization",
            },
            conclude: {
              executive_summary: "4 user segments identified with clear patterns",
              key_findings: "Power users clustered around 3 core features",
              recommendations: "Focus development on core features for power users",
              limitations_caveats: "Segment sizes may shift over time",
              next_steps: "Track segment migration over time",
            },
            "approve-conclusions": { conclusions_approved: "yes" },
            finalize: { deliverables_prepared: "Segmentation report complete" },
          },
        },

        // Scenario 6: Conclusions not approved
        {
          name: "Conclusions not approved - revision needed",
          description: "Initial conclusions rejected, revised",
          expect: { status: "completed" },
          mockInputs: {
            "get-context": {
              business_question: "Marketing ROI",
              context: "Marketing analytics",
              data_sources: "marketing database",
              data_source_type: "inline",
              audience: "Marketing leadership",
            },
            "define-problem": {
              research_question: "Analyze marketing ROI by channel",
              hypotheses: "Social has highest ROI compared to other channels",
              success_criteria: "Clear ROI ranking by channel",
              scope: "Full year data",
              deliverables: "ROI analysis report",
            },
            "approve-problem": { approved: "yes" },
            "collect-data-inline": {
              datasets_info: "Marketing spend and attribution data, 12 months",
              quality_observations: "Attribution may have gaps in tracking",
            },
            "prepare-data": {
              missing_values_strategy: "Use last-touch attribution model",
              transformations_applied: "ROI calculation, Channel grouping",
              final_dataset_info: "Complete channel data for all 5 channels",
            },
            "check-data-quality": { quality_passed: "yes" },
            "explore-data": {
              key_statistics: "Channels: 5, Total spend: $1M, Avg ROI: 2.5x",
              patterns_found: "Social outperforms other channels significantly",
              preliminary_insights: "Social ROI 3x average, TV underperforms",
            },
            "check-eda": { eda_complete: "yes" },
            "find-insights": {
              hypotheses_results: "Social highest ROI hypothesis confirmed with 3x average",
              answer_to_research_question: "Social has 3x ROI compared to channel average",
              key_insights: "Reallocate to social from underperforming TV",
              limitations: "Attribution model limitations may affect accuracy",
              recommendations: "Increase social spend by reallocating from TV",
            },
            visualize: {
              visualizations_created: "ROI by channel bar chart, Trend analysis",
              key_visual_insights: "Clear social dominance visible in charts",
            },
            conclude: [
              {
                executive_summary: "Increase all channel spend generically",
                key_findings: "Social performs well among channels",
                recommendations: "Generic increase across all channels",
                limitations_caveats: "Some limitations in data",
                next_steps: "Review budget allocation",
              },
              {
                executive_summary: "Reallocate 30% from TV to Social channels",
                key_findings: "Social 3x ROI vs TV, clear reallocation opportunity",
                recommendations: "Specific reallocation plan with timeline",
                limitations_caveats: "Monitor for diminishing returns in social",
                next_steps: "Implement reallocation in phases",
              },
            ],
            "approve-conclusions": [
              { conclusions_approved: "no", feedback: "Too generic" },
              { conclusions_approved: "yes" },
            ],
            finalize: { deliverables_prepared: "ROI report with recommendations complete" },
          },
        },

        // Scenario 7: Data quality fix limit reached - escapes to explore-data
        {
          name: "Data quality fix limit reached - escape loop",
          description: "Data quality fix iterations exhausted (3 attempts), escapes to EDA phase",
          expect: { status: "completed" },
          mockInputs: {
            "get-context": {
              business_question: "What drives employee satisfaction?",
              context: "HR analytics for retention",
              data_sources: "hr_database, survey_results",
              data_source_type: "inline",
              audience: "HR leadership team",
            },
            "define-problem": {
              research_question: "Identify key drivers of employee satisfaction scores",
              hypotheses: "Work-life balance and management quality are top drivers",
              success_criteria: "Clear ranking of satisfaction drivers with correlation data",
              scope: "Last 2 years of employee survey data",
              deliverables: "Satisfaction driver analysis report",
            },
            "approve-problem": { approved: "yes" },
            "collect-data-inline": {
              datasets_info: "Employee survey data from HR system, 5000 responses across 2 years",
              quality_observations: "Significant data quality issues detected in survey responses",
            },
            // 3 attempts at prepare-data, all followed by quality check failures
            "prepare-data": [
              {
                missing_values_strategy: "Initial basic imputation for missing survey responses",
                transformations_applied: "Basic cleaning and date formatting applied",
                final_dataset_info: "2000 rows initially cleaned with basic methods",
              },
              {
                missing_values_strategy: "Advanced imputation with median values for survey scores",
                transformations_applied: "Outlier removal and normalization applied",
                final_dataset_info: "3500 rows cleaned with advanced imputation methods",
              },
              {
                missing_values_strategy:
                  "Final attempt with interpolation and cross-validation checks",
                transformations_applied: "Full pipeline including deduplication and validation",
                final_dataset_info: "4000 rows cleaned but still has edge case issues",
              },
            ],
            "check-data-quality": [
              { quality_passed: "no", issues_found: "Too many nulls in key fields" },
              { quality_passed: "no", issues_found: "Inconsistent date formats remain" },
              { quality_passed: "no", issues_found: "Outliers still present in scores" },
            ],
            // After 3rd failure, expr increments to 3, check: 3 < 3 = false → ask-user-dq-fix-limit-reached
            "ask-user-dq-fix-limit-reached": { decision: "continue" },
            "explore-data": {
              key_statistics: "Average satisfaction: 3.5/5, Response rate: 75%, Departments: 8",
              patterns_found: "Management scores correlate with overall satisfaction",
              preliminary_insights: "Work-life balance strongest predictor despite data issues",
            },
            "check-eda": { eda_complete: "yes" },
            "find-insights": {
              hypotheses_results:
                "Work-life balance hypothesis confirmed as top driver in analysis",
              answer_to_research_question:
                "Work-life balance and management quality drive satisfaction scores",
              key_insights: "Work-life balance accounts for 40% of satisfaction variance",
              limitations: "Data quality issues may affect precision of results",
              recommendations: "Focus on work-life balance programs and management training",
            },
            visualize: {
              visualizations_created: "Driver ranking chart, Correlation heatmap, Trend analysis",
              key_visual_insights:
                "Clear correlation between work-life balance and satisfaction visible",
            },
            conclude: {
              executive_summary: "Work-life balance is the primary driver of employee satisfaction",
              key_findings:
                "Work-life balance accounts for 40% of satisfaction variance across departments",
              recommendations: "Invest in flexible work programs and management quality training",
              limitations_caveats: "Data quality issues may affect precision",
              next_steps: "Implement flexible work pilot and resurvey",
            },
            "approve-conclusions": { conclusions_approved: "yes" },
            finalize: {
              deliverables_prepared: "Employee satisfaction driver analysis report complete",
            },
          },
        },

        // Scenario 8: EDA fix limit reached - escapes to find-insights
        {
          name: "EDA fix limit reached - escape loop",
          description: "EDA fix iterations exhausted (3 attempts), escapes to insights phase",
          expect: { status: "completed" },
          mockInputs: {
            "get-context": {
              business_question: "What are the seasonal demand patterns?",
              context: "Supply chain optimization",
              data_sources: "inventory_system, sales_database",
              data_source_type: "inline",
              audience: "Supply chain team",
            },
            "define-problem": {
              research_question: "Identify seasonal demand patterns for inventory optimization",
              hypotheses: "Q4 has highest demand and summer shows distinct patterns",
              success_criteria: "Clear seasonal patterns identified with forecast model",
              scope: "Last 3 years of sales and inventory data",
              deliverables: "Seasonal demand analysis and forecast report",
            },
            "approve-problem": { approved: "yes" },
            "collect-data-inline": {
              datasets_info: "Sales and inventory data from internal systems, 3 years of records",
              quality_observations: "Data appears complete with good coverage across all quarters",
            },
            "prepare-data": {
              missing_values_strategy: "Forward fill for missing inventory snapshots",
              transformations_applied: "Time series decomposition and seasonal indexing applied",
              final_dataset_info:
                "Complete dataset with 36 months of daily records ready for analysis",
            },
            "check-data-quality": { quality_passed: "yes" },
            // 3 attempts at explore-data, all followed by EDA completeness failures
            "explore-data": [
              {
                key_statistics: "Total records: 36000, Products: 500, Regions: 4 in dataset",
                patterns_found: "Initial seasonal trends visible in aggregate",
                preliminary_insights: "Some clustering by product category appearing",
              },
              {
                key_statistics:
                  "Total records: 36000, Categories: 10, Seasonal index range: 0.7-1.4",
                patterns_found: "Stronger seasonal patterns emerging by category now",
                preliminary_insights: "Category-level analysis shows distinct seasonal profiles",
              },
              {
                key_statistics:
                  "Total records: 36000, Segments: 5, Forecast accuracy: ~70% estimated",
                patterns_found: "Regional seasonal patterns differ significantly from aggregate",
                preliminary_insights:
                  "Need regional breakdown but analysis remains incomplete overall",
              },
            ],
            "check-eda": [
              { eda_complete: "no", gaps_found: "Need product-level seasonal decomposition" },
              { eda_complete: "no", gaps_found: "Need regional breakdown analysis" },
              { eda_complete: "no", gaps_found: "Need cross-category correlations" },
            ],
            // After 3rd failure, expr increments to 3, check: 3 < 3 = false → ask-user-eda-fix-limit-reached
            "ask-user-eda-fix-limit-reached": { decision: "continue" },
            "find-insights": {
              hypotheses_results: "Q4 peak hypothesis confirmed with seasonal index of 1.4 average",
              answer_to_research_question:
                "Clear Q4 peak with summer dip pattern across all categories",
              key_insights: "Seasonal index varies 0.7-1.4 with Q4 consistently highest",
              limitations: "EDA incomplete, regional patterns not fully explored",
              recommendations: "Adjust inventory levels by seasonal index per category",
            },
            visualize: {
              visualizations_created:
                "Seasonal decomposition chart, Category heatmap, Forecast plot",
              key_visual_insights: "Clear Q4 peaks visible across all product categories",
            },
            conclude: {
              executive_summary: "Strong seasonal patterns identified with Q4 peak at 1.4x average",
              key_findings: "Q4 demand is 40% above average across all categories consistently",
              recommendations: "Pre-position inventory 30% above baseline for Q4 season",
              limitations_caveats: "Regional patterns need further analysis",
              next_steps: "Implement automated seasonal inventory adjustments",
            },
            "approve-conclusions": { conclusions_approved: "yes" },
            finalize: {
              deliverables_prepared: "Seasonal demand analysis and forecast report complete",
            },
          },
        },
        // Scenario 9: Data quality and EDA fix limit reached - user resets counters
        {
          name: "Fix limit reached - user resets counters",
          description:
            "Data quality and EDA fix limits reached, user resets counters to retry fixing",
          expect: { status: "completed" },
          mockInputs: {
            "get-context": {
              business_question: "What drives website bounce rate?",
              context: "Web analytics improvement",
              data_sources: "analytics_database",
              data_source_type: "inline",
              audience: "Growth team",
            },
            "define-problem": {
              research_question: "Identify factors driving high bounce rate on landing pages",
              hypotheses: "Page load time and content relevance are primary bounce drivers",
              success_criteria: "Clear bounce rate drivers identified with actionable insights",
              scope: "Last 6 months of web analytics data",
              deliverables: "Bounce rate analysis report with recommendations",
            },
            "approve-problem": { approved: "yes" },
            "collect-data-inline": {
              datasets_info: "Web analytics data from tracking system, 100000 sessions",
              quality_observations: "Raw data has quality issues needing cleanup",
            },
            // Data quality: fail 3 times, then reset, then succeed
            "prepare-data": [
              {
                missing_values_strategy: "Basic imputation for missing page load times",
                transformations_applied: "Basic cleaning",
                final_dataset_info: "50000 rows with initial cleaning",
              },
              {
                missing_values_strategy: "Median imputation for numeric fields",
                transformations_applied: "Outlier detection applied",
                final_dataset_info: "70000 rows after second cleaning pass",
              },
              {
                missing_values_strategy: "Advanced interpolation for time series gaps",
                transformations_applied: "Full pipeline with dedup",
                final_dataset_info: "80000 rows but edge cases remain",
              },
              // After reset, prepare-data succeeds
              {
                missing_values_strategy: "Complete pipeline with validated imputation",
                transformations_applied: "Full cleaning, normalization, validation",
                final_dataset_info: "95000 clean rows ready for analysis",
              },
            ],
            "check-data-quality": [
              { quality_passed: "no", issues_found: "Missing page load times" },
              { quality_passed: "no", issues_found: "Inconsistent session IDs" },
              { quality_passed: "no", issues_found: "Duplicate entries detected" },
              // After reset and re-preparation
              { quality_passed: "yes" },
            ],
            "ask-user-dq-fix-limit-reached": { decision: "reset" },
            // EDA: fail 3 times, then reset, then succeed
            "explore-data": [
              {
                key_statistics: "Total sessions: 95000, Bounce rate: 45%, Avg load: 3.2s",
                patterns_found: "Initial correlation between load time and bounce",
                preliminary_insights: "Slow pages bounce more often",
              },
              {
                key_statistics: "Total sessions: 95000, Segments: 3, Mobile: 60%",
                patterns_found: "Mobile bounce rate significantly higher",
                preliminary_insights: "Mobile experience needs investigation",
              },
              {
                key_statistics: "Total sessions: 95000, Landing pages: 50, Top bouncer: /pricing",
                patterns_found: "Pricing page has 70% bounce rate",
                preliminary_insights: "Pricing page needs deep analysis",
              },
              // After reset
              {
                key_statistics:
                  "Total sessions: 95000, Bounce rate: 45%, Load time correlation: 0.72",
                patterns_found:
                  "Load time > 3s causes 65% bounce, mobile 2x worse, pricing page outlier",
                preliminary_insights:
                  "Three main drivers: load time, mobile UX, and pricing page design",
              },
            ],
            "check-eda": [
              { eda_complete: "no", gaps_found: "Need device-level breakdown" },
              { eda_complete: "no", gaps_found: "Need page-level analysis" },
              { eda_complete: "no", gaps_found: "Need content relevance correlation" },
              // After reset
              { eda_complete: "yes" },
            ],
            "ask-user-eda-fix-limit-reached": { decision: "reset" },
            "find-insights": {
              hypotheses_results: "Page load time hypothesis confirmed with 0.72 correlation",
              answer_to_research_question:
                "Load time, mobile UX, and pricing page design drive bounce rate",
              key_insights: "Pages loading > 3s have 65% bounce rate vs 25% for fast pages",
              limitations: "Content relevance not fully quantified",
              recommendations: "Optimize page load, improve mobile UX, redesign pricing page",
            },
            visualize: {
              visualizations_created:
                "Load time vs bounce scatter, Device comparison, Page heatmap",
              key_visual_insights: "Clear load time threshold at 3 seconds visible in scatter plot",
            },
            conclude: {
              executive_summary:
                "Page load time is primary bounce driver with 3s threshold, mobile 2x impact",
              key_findings: "Load time > 3s = 65% bounce, mobile bounce 2x desktop",
              recommendations: "CDN optimization, mobile-first redesign, pricing page A/B test",
              limitations_caveats: "Content relevance analysis incomplete",
              next_steps: "Implement CDN and measure impact on bounce rate",
            },
            "approve-conclusions": { conclusions_approved: "yes" },
            finalize: {
              deliverables_prepared: "Bounce rate analysis report with recommendations complete",
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
