/**
 * User Approval Scenarios for software-development-flow
 *
 * Tests user approval flows: rejection, feedback, plan updates.
 */

import type { TestScenario } from "../../../helpers/scenario-runner.js";
import * as inputs from "./base-inputs.js";

export const userApprovalScenarios: TestScenario[] = [
  // Scenario 1: User rejects step without plan update
  {
    name: "User step rejection - no plan update",
    description: "User rejects step, issues fixed without plan changes",
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
      "initialize-plan-tracking": inputs.singleStepPlanTracking,
      "initial-system-startup": inputs.initialSystemStartup,
      "initial-run-tests": inputs.initialTestsRun,
      "create-initial-iteration-workspace": inputs.standardInitialIterationWorkspace,
      "implement-step": inputs.standardImplementation,
      "create-iteration-workspace": [
        inputs.standardIterationWorkspace,
        {
          step_results_file:
            "./moira-ws/user-auth-20251225-1200/step-1/iteration-2/step-results.md",
        },
      ],
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
      "check-user-approval-needed": inputs.userApprovalNeeded,
      // User rejects
      "user-review-step": [inputs.userStepRejectedNoPlanUpdate, inputs.userStepApproved],
      "record-feedback-to-requirements": inputs.recordFeedbackNoPlanUpdate,
      "update-current-step-plan": inputs.updateCurrentStepPlan,
      "read-prior-iteration-results": inputs.priorIterationResultsRead,
      // After fix: continue
      "validate-requirements-coverage": inputs.requirementsCoverageValid,
      "generate-final-report": inputs.finalReportGenerated,
      "present-results": inputs.userPermissionGranted,
      "collect-user-feedback": inputs.userSatisfied,
      "update-documentation": inputs.finalDocumentationUpdate,
    },
  },

  // Scenario 2: User rejects step with plan update
  // Flow: iter 1 → user rejects (plan update) → update plan → reinitialize → iter 2 → user approves → finish
  {
    name: "User step rejection - with plan update",
    description: "User rejects step, feedback requires plan changes",
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
      "initialize-plan-tracking": inputs.singleStepPlanTracking,
      "initial-system-startup": inputs.initialSystemStartup,
      "initial-run-tests": inputs.initialTestsRun,
      // Iteration 1 + Iteration 2 (after reinitialize)
      "create-initial-iteration-workspace": [
        inputs.standardInitialIterationWorkspace,
        inputs.standardInitialIterationWorkspace,
      ],
      "implement-step": [
        inputs.standardImplementation,
        { implemented_functionality: "Implemented per updated plan" },
      ],
      "create-iteration-workspace": [
        inputs.standardIterationWorkspace,
        {
          step_results_file:
            "./moira-ws/user-auth-20251225-1200/step-1/iteration-2/step-results.md",
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
      "update-step-documentation": [
        inputs.stepDocumentationUpdated,
        inputs.stepDocumentationUpdated,
      ],
      "check-project-checklist": [inputs.checklistPassed, inputs.checklistPassed],
      "agent-validate-step": [inputs.agentValidationPassed, inputs.agentValidationPassed],
      "commit-step": [inputs.commitStep, inputs.commitStep],
      // Iter 1: approval needed, Iter 2: no approval needed
      "check-user-approval-needed": [inputs.userApprovalNeeded, inputs.userApprovalNotNeeded],
      "get-next-step-name": inputs.nextStepName,
      // Iter 1: user rejects with plan update
      "user-review-step": inputs.userStepRejectedWithPlanUpdate,
      "record-feedback-to-requirements": inputs.recordFeedbackWithPlanUpdate,
      // Plan update flow
      "approve-current-step-before-replan": inputs.approveCurrentStepBeforeReplan,
      "create-plan-change-reasons": inputs.planChangeReasonsDocumented,
      "update-plan-during-execution": inputs.planUpdateDuringExecution,
      "review-updated-plan": inputs.planUpdateReviewPassed,
      "confirm-plan-update": inputs.planUpdateApproved,
      "set-update-total-steps": { total_steps: 2 },
      "reinitialize-plan-tracking": {
        tracking_reinitialized: "yes",
      },
      // Finish after iter 2 passes (no user approval needed on iter 2)
      "validate-requirements-coverage": inputs.requirementsCoverageValid,
      "generate-final-report": inputs.finalReportGenerated,
      "present-results": inputs.userPermissionGranted,
      "collect-user-feedback": inputs.userSatisfied,
      "update-documentation": inputs.finalDocumentationUpdate,
    },
  },

  // Scenario 3: Multiple user rejections
  {
    name: "Multiple user rejections",
    description: "User rejects multiple times before approval",
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
      "initialize-plan-tracking": inputs.singleStepPlanTracking,
      "initial-system-startup": inputs.initialSystemStartup,
      "initial-run-tests": inputs.initialTestsRun,
      "create-initial-iteration-workspace": inputs.standardInitialIterationWorkspace,
      "implement-step": inputs.standardImplementation,
      "create-iteration-workspace": [
        inputs.standardIterationWorkspace,
        {
          step_results_file:
            "./moira-ws/user-auth-20251225-1200/step-1/iteration-2/step-results.md",
        },
        {
          step_results_file:
            "./moira-ws/user-auth-20251225-1200/step-1/iteration-3/step-results.md",
        },
      ],
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
      "check-user-approval-needed": inputs.userApprovalNeeded,
      // User rejects twice then approves
      "user-review-step": [
        inputs.userStepRejectedNoPlanUpdate,
        inputs.userStepRejectedNoPlanUpdate,
        inputs.userStepApproved,
      ],
      "record-feedback-to-requirements": [
        inputs.recordFeedbackNoPlanUpdate,
        inputs.recordFeedbackNoPlanUpdate,
      ],
      "update-current-step-plan": [inputs.updateCurrentStepPlan, inputs.updateCurrentStepPlan],
      "read-prior-iteration-results": inputs.priorIterationResultsRead,
      "validate-requirements-coverage": inputs.requirementsCoverageValid,
      "generate-final-report": inputs.finalReportGenerated,
      "present-results": inputs.userPermissionGranted,
      "collect-user-feedback": inputs.userSatisfied,
      "update-documentation": inputs.finalDocumentationUpdate,
    },
  },

  // Scenario 4: User approval not required (auto-proceed)
  {
    name: "User approval not required",
    description: "Step doesn't require user approval, auto-proceeds",
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
      // User approval not required
      "check-user-approval-needed": inputs.userApprovalNotNeeded,
      // Skip user-review-step, go directly to completion
      "validate-requirements-coverage": inputs.requirementsCoverageValid,
      "generate-final-report": inputs.finalReportGenerated,
      "present-results": inputs.userPermissionGranted,
      "collect-user-feedback": inputs.userSatisfied,
      "update-documentation": inputs.finalDocumentationUpdate,
    },
  },
];
