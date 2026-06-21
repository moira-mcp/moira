/**
 * Development Workflow Scenarios Index
 *
 * Exports all scenario modules for software-development-flow testing.
 * Each module contains scenarios for specific workflow paths.
 *
 * Production workflow v9.0.0: 279 nodes (138 agent-directive, 96 condition, 9 notification, 33 expression, 1 start, 1 end, 1 teleport)
 * 74 scenarios achieve 100% node and branch coverage
 */

export { happyPathScenarios } from "./happy-paths.js";
export { skipPatternScenarios } from "./skip-patterns.js";
export { fixCycleScenarios } from "./fix-cycles.js";
export { planFlowScenarios } from "./plan-flows.js";
export { documentationResearchScenarios } from "./documentation-research.js";
export { userApprovalScenarios } from "./user-approval.js";
export { checklistFlowScenarios } from "./checklist-flows.js";
export { edgeCaseScenarios } from "./edge-cases.js";
export { reviewLimitScenarios } from "./review-limits.js";
export * as baseInputs from "./base-inputs.js";

import type { TestScenario } from "../../../helpers/scenario-runner.js";
import { happyPathScenarios } from "./happy-paths.js";
import { skipPatternScenarios } from "./skip-patterns.js";
import { fixCycleScenarios } from "./fix-cycles.js";
import { planFlowScenarios } from "./plan-flows.js";
import { documentationResearchScenarios } from "./documentation-research.js";
import { userApprovalScenarios } from "./user-approval.js";
import { checklistFlowScenarios } from "./checklist-flows.js";
import { edgeCaseScenarios } from "./edge-cases.js";
import { reviewLimitScenarios } from "./review-limits.js";

/**
 * All scenarios combined for full coverage testing
 */
export const allScenarios: TestScenario[] = [
  ...happyPathScenarios,
  ...skipPatternScenarios,
  ...fixCycleScenarios,
  ...planFlowScenarios,
  ...documentationResearchScenarios,
  ...userApprovalScenarios,
  ...checklistFlowScenarios,
  ...edgeCaseScenarios,
  ...reviewLimitScenarios,
];
