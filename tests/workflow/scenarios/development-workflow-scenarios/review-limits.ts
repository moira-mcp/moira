/**
 * Review Limit Scenarios for software-development-flow
 *
 * Tests the review fix limit pattern for all 4 review types:
 * plan, refine, extend, update.
 *
 * Each review type has a counter that increments on each failed fix attempt.
 * When counter reaches max (3), user is asked to decide: "continue" or "reset".
 * - "continue": proceed to next phase as-is
 * - "reset": reset counter to 0, loop back to fix, then review passes
 *
 * Covers these previously unvisited nodes:
 * - ask-user-plan-review-limit-reached / route-plan-review-limit-decision / expr-reset-plan-review-counter
 * - ask-user-refine-review-limit-reached / route-refine-review-limit-decision / expr-reset-refine-review-counter
 * - ask-user-extend-review-limit-reached / route-extend-review-limit-decision / expr-reset-extend-review-counter
 * - ask-user-update-review-limit-reached / route-update-review-limit-decision / expr-reset-update-review-counter
 */

import type { TestScenario } from "../../../helpers/scenario-runner.js";
import * as inputs from "./base-inputs.js";

/**
 * Common tail: single-step implementation that passes all checks through to end.
 * Used by all review limit scenarios after the plan phase completes.
 */
const singleStepHappyTail = {
  "initialize-plan-tracking": inputs.singleStepPlanTracking,
  "initial-system-startup": inputs.initialSystemStartup,
  "initial-run-tests": inputs.initialTestsRun,
  "create-initial-iteration-workspace": inputs.standardInitialIterationWorkspace,
  "implement-step": inputs.standardImplementation,
  "create-iteration-workspace": inputs.standardIterationWorkspace,
  "restart-and-rebuild": inputs.startupSuccess,
  "analyze-implementation-changes": inputs.codeChanges,
  "analyze-code-changes": inputs.codeAnalysisWithFunctions,
  "verify-functionality-manually": inputs.allFunctionsWorking,
  "run-all-tests": inputs.allTestsPass,
  "check-implementation-completeness": inputs.implementationComplete,
  "check-code-quality-and-architecture": inputs.qualityCheckPassed,
  "check-browser-impact": inputs.noBrowserTesting,
  "assess-testing-needs": inputs.noNewTestsRequired,
  "update-step-documentation": inputs.stepDocumentationUpdated,
  "check-project-checklist": inputs.checklistPassed,
  "agent-validate-step": inputs.agentValidationPassed,
  "commit-step": inputs.commitStep,
  "check-user-approval-needed": inputs.userApprovalNotNeeded,
  "validate-requirements-coverage": inputs.requirementsCoverageValid,
  "generate-final-report": inputs.finalReportGenerated,
  "present-results": inputs.userPermissionGranted,
  "collect-user-feedback": inputs.userSatisfied,
  "update-documentation": inputs.finalDocumentationUpdate,
};

/**
 * Two-step tail: step 1 complete → user not satisfied → extension → step 2 → satisfied.
 * Used by extend review limit scenarios.
 */
const twoStepWithExtensionTail = {
  "initialize-plan-tracking": inputs.singleStepPlanTracking,
  "initial-system-startup": inputs.initialSystemStartup,
  "initial-run-tests": inputs.initialTestsRun,
  // Step 1 + Step 2
  "create-initial-iteration-workspace": [
    inputs.standardInitialIterationWorkspace,
    inputs.standardInitialIterationWorkspace,
  ],
  "implement-step": [
    inputs.standardImplementation,
    { implemented_functionality: "Added extension step implementation" },
  ],
  "create-iteration-workspace": [
    inputs.standardIterationWorkspace,
    {
      step_results_file: "./moira-ws/user-auth-20251225-1200/step-2/iteration-1/step-results.md",
    },
  ],
  "restart-and-rebuild": [inputs.startupSuccess, inputs.startupSuccess],
  "analyze-implementation-changes": [inputs.codeChanges, inputs.codeChanges],
  "analyze-code-changes": [inputs.codeAnalysisWithFunctions, inputs.codeAnalysisWithFunctions],
  "verify-functionality-manually": [inputs.allFunctionsWorking, inputs.allFunctionsWorking],
  "run-all-tests": [inputs.allTestsPass, inputs.allTestsPass],
  "check-implementation-completeness": [
    inputs.implementationComplete,
    inputs.implementationComplete,
  ],
  "check-code-quality-and-architecture": [inputs.qualityCheckPassed, inputs.qualityCheckPassed],
  "check-browser-impact": [inputs.noBrowserTesting, inputs.noBrowserTesting],
  "assess-testing-needs": [inputs.noNewTestsRequired, inputs.noNewTestsRequired],
  "update-step-documentation": [inputs.stepDocumentationUpdated, inputs.stepDocumentationUpdated],
  "check-project-checklist": [inputs.checklistPassed, inputs.checklistPassed],
  "agent-validate-step": [inputs.agentValidationPassed, inputs.agentValidationPassed],
  "commit-step": [inputs.commitStep, inputs.commitStep],
  "check-user-approval-needed": [inputs.userApprovalNotNeeded, inputs.userApprovalNotNeeded],
  "validate-requirements-coverage": inputs.requirementsCoverageValid,
  "generate-final-report": [inputs.finalReportGenerated, inputs.finalReportGeneratedV2],
  "read-prior-report": inputs.priorReportRead,
  "present-results": [inputs.userPermissionGranted, inputs.userPermissionGranted],
  // Step 1 → not satisfied → extension, Step 2 → satisfied
  "collect-user-feedback": [inputs.userNotSatisfied, inputs.userSatisfied],
  "record-user-feedback-to-requirements": inputs.userFeedbackRecorded,
  "create-plan-change-reasons": inputs.planChangeReasonsDocumented,
  "create-additional-steps": inputs.additionalStepsCreated,
  "set-extension-total-steps": { total_steps: 2 },
  "get-next-step-name": { current_step_name: "Extension step" },
  "update-documentation": inputs.finalDocumentationUpdate,
};

/**
 * Plan update tail: agent validation fails with plan update → update plan → approve → reinitialize → step 2 → done.
 * Used by update review limit scenarios.
 */
const planUpdateTail = {
  "initialize-plan-tracking": inputs.singleStepPlanTracking,
  "initial-system-startup": inputs.initialSystemStartup,
  "initial-run-tests": inputs.initialTestsRun,
  // Iter 1 (fails with plan update) + Iter 2 (after reinitialize, passes)
  "create-initial-iteration-workspace": [
    inputs.standardInitialIterationWorkspace,
    inputs.standardInitialIterationWorkspace,
  ],
  "implement-step": [
    inputs.standardImplementation,
    { implemented_functionality: "Updated implementation after plan change" },
  ],
  "create-iteration-workspace": [
    inputs.standardIterationWorkspace,
    {
      step_results_file: "./moira-ws/user-auth-20251225-1200/step-1/iteration-2/step-results.md",
    },
  ],
  "restart-and-rebuild": [inputs.startupSuccess, inputs.startupSuccess],
  "analyze-implementation-changes": [inputs.codeChanges, inputs.codeChanges],
  "analyze-code-changes": [inputs.codeAnalysisWithFunctions, inputs.codeAnalysisWithFunctions],
  "verify-functionality-manually": [inputs.allFunctionsWorking, inputs.allFunctionsWorking],
  "run-all-tests": [inputs.allTestsPass, inputs.allTestsPass],
  "check-implementation-completeness": [
    inputs.implementationComplete,
    inputs.implementationComplete,
  ],
  "check-code-quality-and-architecture": [inputs.qualityCheckPassed, inputs.qualityCheckPassed],
  "check-browser-impact": [inputs.noBrowserTesting, inputs.noBrowserTesting],
  "assess-testing-needs": [inputs.noNewTestsRequired, inputs.noNewTestsRequired],
  "update-step-documentation": [inputs.stepDocumentationUpdated, inputs.stepDocumentationUpdated],
  "check-project-checklist": [inputs.checklistPassed, inputs.checklistPassed],
  // Iter 1: fails with plan update, Iter 2: passes
  "agent-validate-step": [inputs.agentValidationFailedWithPlanUpdate, inputs.agentValidationPassed],
  "fix-agent-feedback-issues-action": inputs.fixAgentFeedbackWithPlanUpdate,
  "approve-current-step-before-replan": inputs.approveCurrentStepBeforeReplan,
  "create-plan-change-reasons": inputs.planChangeReasonsDocumented,
  "update-plan-during-execution": inputs.planUpdateDuringExecution,
  "set-update-total-steps": { total_steps: 2 },
  "reinitialize-plan-tracking": {
    tracking_reinitialized: "yes",
  },
  "get-next-step-name": inputs.nextStepName,
  // After iter 2 passes
  "commit-step": inputs.commitStep,
  "check-user-approval-needed": inputs.userApprovalNotNeeded,
  "validate-requirements-coverage": inputs.requirementsCoverageValid,
  "generate-final-report": inputs.finalReportGenerated,
  "present-results": inputs.userPermissionGranted,
  "collect-user-feedback": inputs.userSatisfied,
  "update-documentation": inputs.finalDocumentationUpdate,
};

export const reviewLimitScenarios: TestScenario[] = [
  // =========================================================================
  // PLAN REVIEW LIMIT
  // =========================================================================

  // Scenario 1: Plan review limit reached - continue
  // Flow: 3 failed reviews → counter=3 → ask-user (continue) → route(false) → notify-plan-ready → present-plan → ... → end
  {
    name: "Plan review limit reached - continue",
    description: "Agent review finds issues 3 times, user decides to continue with current result",
    expect: { status: "completed" },
    mockInputs: {
      ...inputs.standardPipeline,
      "get-task-requirements": inputs.standardTaskRequirements,
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": inputs.standardFeatureWorkspace,
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": inputs.standardPlan,
      // 10 reviews all with issues
      "agent-review-plan": [
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
      ],
      // fix called 9 times (counter 1 through 9; at counter 10 limit is reached)
      "fix-plan-issues": [{}, {}, {}, {}, {}, {}, {}, {}, {}],
      // Limit reached → user decides to continue
      "ask-user-plan-review-limit-reached": { plan_review_limit_decision: "continue" },
      // route-plan-review-limit-decision (false) → notify-plan-ready → present-plan-to-user
      "present-plan-to-user": inputs.planApproved,
      ...singleStepHappyTail,
    },
  },

  // Scenario 2: Plan review limit reached - reset
  // Flow: 3 failed reviews → ask-user (reset) → route(true) → expr-reset(counter=0) → fix → review(no issues) → continue
  {
    name: "Plan review limit reached - reset",
    description: "Agent review finds issues 3 times, user resets counter, review passes on retry",
    expect: { status: "completed" },
    mockInputs: {
      ...inputs.standardPipeline,
      "get-task-requirements": inputs.standardTaskRequirements,
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": inputs.standardFeatureWorkspace,
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": inputs.standardPlan,
      // 10 reviews with issues + 1 review with no issues (after reset and fix)
      "agent-review-plan": [
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewWithIssues,
        inputs.planReviewNoIssues,
      ],
      // fix called 9 times before limit + 1 time after reset = 10 total
      "fix-plan-issues": [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}],
      // Limit reached → user decides to reset
      "ask-user-plan-review-limit-reached": { plan_review_limit_decision: "reset" },
      // route(true) → expr-reset → fix → review(no issues) → notify-plan-ready → present-plan
      "present-plan-to-user": inputs.planApproved,
      ...singleStepHappyTail,
    },
  },

  // =========================================================================
  // REFINE REVIEW LIMIT
  // =========================================================================

  // Scenario 3: Refine review limit reached - continue
  // Flow: plan rejected → refine → 3 failed reviews → ask-user (continue) → route(false) → notify-plan-refined → confirm
  {
    name: "Refine review limit reached - continue",
    description: "Refinement review finds issues 3 times, user decides to continue",
    expect: { status: "completed" },
    mockInputs: {
      ...inputs.standardPipeline,
      "get-task-requirements": inputs.standardTaskRequirements,
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": inputs.standardFeatureWorkspace,
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": inputs.standardPlan,
      "agent-review-plan": inputs.planReviewNoIssues,
      "present-plan-to-user": inputs.planRejected,
      "create-plan-change-reasons": inputs.planChangeReasonsDocumented,
      "refine-development-plan": inputs.planRefinement,
      // 10 reviews all with issues
      "review-refined-plan": [
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
      ],
      // fix called 9 times (counter 1 through 9)
      "fix-refined-plan-issues": [{}, {}, {}, {}, {}, {}, {}, {}, {}],
      // Limit reached → user continues
      "ask-user-refine-review-limit-reached": { refine_review_limit_decision: "continue" },
      // route(false) → notify-plan-refined → confirm-plan-refinement
      "confirm-plan-refinement": inputs.refinementApproved,
      ...singleStepHappyTail,
    },
  },

  // Scenario 4: Refine review limit reached - reset
  // Flow: plan rejected → refine → 3 failed reviews → reset → fix → review passes → confirm
  {
    name: "Refine review limit reached - reset",
    description:
      "Refinement review finds issues 3 times, user resets counter, review passes on retry",
    expect: { status: "completed" },
    mockInputs: {
      ...inputs.standardPipeline,
      "get-task-requirements": inputs.standardTaskRequirements,
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": inputs.standardFeatureWorkspace,
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": inputs.standardPlan,
      "agent-review-plan": inputs.planReviewNoIssues,
      "present-plan-to-user": inputs.planRejected,
      "create-plan-change-reasons": inputs.planChangeReasonsDocumented,
      "refine-development-plan": inputs.planRefinement,
      // 10 reviews with issues + 1 with no issues (after reset)
      "review-refined-plan": [
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewFailed,
        inputs.refinementReviewPassed,
      ],
      // fix called 9 times before limit + 1 time after reset = 10 total
      "fix-refined-plan-issues": [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}],
      // Limit reached → user resets
      "ask-user-refine-review-limit-reached": { refine_review_limit_decision: "reset" },
      // route(true) → expr-reset → fix → review(no issues) → notify-plan-refined → confirm
      "confirm-plan-refinement": inputs.refinementApproved,
      ...singleStepHappyTail,
    },
  },

  // =========================================================================
  // EXTEND REVIEW LIMIT
  // =========================================================================

  // Scenario 5: Extend review limit reached - continue
  // Flow: step 1 → not satisfied → create steps → 3 failed reviews → ask-user (continue) → route(false) → notify-plan-extended → confirm
  {
    name: "Extend review limit reached - continue",
    description: "Extension review finds issues 3 times, user decides to continue",
    expect: { status: "completed" },
    mockInputs: {
      ...inputs.standardPipeline,
      "get-task-requirements": inputs.standardTaskRequirements,
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": inputs.standardFeatureWorkspace,
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": inputs.standardPlan,
      "agent-review-plan": inputs.planReviewNoIssues,
      "present-plan-to-user": inputs.planApproved,
      // 10 extension reviews all with issues
      "review-extended-plan": [
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
      ],
      // fix called 9 times (counter 1 through 9)
      "fix-extension-plan-issues": [{}, {}, {}, {}, {}, {}, {}, {}, {}],
      // Limit reached → user continues
      "ask-user-extend-review-limit-reached": { extend_review_limit_decision: "continue" },
      // route(false) → notify-plan-extended → confirm-plan-extension
      "confirm-plan-extension": inputs.extensionApproved,
      ...twoStepWithExtensionTail,
    },
  },

  // Scenario 6: Extend review limit reached - reset
  // Flow: step 1 → not satisfied → create steps → 3 failed reviews → reset → fix → review passes → confirm
  {
    name: "Extend review limit reached - reset",
    description:
      "Extension review finds issues 3 times, user resets counter, review passes on retry",
    expect: { status: "completed" },
    mockInputs: {
      ...inputs.standardPipeline,
      "get-task-requirements": inputs.standardTaskRequirements,
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": inputs.standardFeatureWorkspace,
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": inputs.standardPlan,
      "agent-review-plan": inputs.planReviewNoIssues,
      "present-plan-to-user": inputs.planApproved,
      // 10 reviews with issues + 1 with no issues (after reset)
      "review-extended-plan": [
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewFailed,
        inputs.extensionReviewPassed,
      ],
      // fix called 9 times before limit + 1 time after reset = 10 total
      "fix-extension-plan-issues": [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}],
      // Limit reached → user resets
      "ask-user-extend-review-limit-reached": { extend_review_limit_decision: "reset" },
      // route(true) → expr-reset → fix → review(no issues) → notify-plan-extended → confirm
      "confirm-plan-extension": inputs.extensionApproved,
      ...twoStepWithExtensionTail,
    },
  },

  // =========================================================================
  // UPDATE REVIEW LIMIT
  // =========================================================================

  // Scenario 7: Update review limit reached - continue
  // Flow: agent fails → update plan → 3 failed reviews → ask-user (continue) → route(false) → confirm-plan-update → reinitialize → step 2
  {
    name: "Update review limit reached - continue",
    description: "Updated plan review finds issues 3 times, user decides to continue",
    expect: { status: "completed" },
    mockInputs: {
      ...inputs.standardPipeline,
      "get-task-requirements": inputs.standardTaskRequirements,
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": inputs.standardFeatureWorkspace,
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": inputs.standardPlan,
      "agent-review-plan": inputs.planReviewNoIssues,
      "present-plan-to-user": inputs.planApproved,
      // 10 update reviews all with issues
      "review-updated-plan": [
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
      ],
      // fix called 9 times (counter 1 through 9)
      "fix-updated-plan-issues": [{}, {}, {}, {}, {}, {}, {}, {}, {}],
      // Limit reached → user continues
      "ask-user-update-review-limit-reached": { update_review_limit_decision: "continue" },
      // route(false) → confirm-plan-update
      "confirm-plan-update": inputs.planUpdateApproved,
      ...planUpdateTail,
    },
  },

  // Scenario 8: Update review limit reached - reset
  // Flow: agent fails → update plan → 3 failed reviews → reset → fix → review passes → confirm-plan-update → reinitialize → step 2
  {
    name: "Update review limit reached - reset",
    description:
      "Updated plan review finds issues 3 times, user resets counter, review passes on retry",
    expect: { status: "completed" },
    mockInputs: {
      ...inputs.standardPipeline,
      "get-task-requirements": inputs.standardTaskRequirements,
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": inputs.standardFeatureWorkspace,
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": inputs.standardPlan,
      "agent-review-plan": inputs.planReviewNoIssues,
      "present-plan-to-user": inputs.planApproved,
      // 10 reviews with issues + 1 with no issues (after reset)
      "review-updated-plan": [
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewFailed,
        inputs.planUpdateReviewPassed,
      ],
      // fix called 9 times before limit + 1 time after reset = 10 total
      "fix-updated-plan-issues": [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}],
      // Limit reached → user resets
      "ask-user-update-review-limit-reached": { update_review_limit_decision: "reset" },
      // route(true) → expr-reset → fix → review(no issues) → confirm-plan-update
      "confirm-plan-update": inputs.planUpdateApproved,
      ...planUpdateTail,
    },
  },
];
