/**
 * Plan Flow Scenarios for software-development-flow
 *
 * Tests plan rejection, refinement, review issues, and extension paths.
 */

import type { TestScenario } from "../../../helpers/scenario-runner.js";
import * as inputs from "./base-inputs.js";

export const planFlowScenarios: TestScenario[] = [
  // Scenario 1: Plan rejected, refined, approved
  {
    name: "Plan rejection and refinement",
    description: "User rejects initial plan, agent refines it, user approves",
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
      // First: user rejects plan
      "present-plan-to-user": [inputs.planRejected, inputs.planApproved],
      "create-plan-change-reasons": inputs.planChangeReasonsDocumented,
      "refine-development-plan": inputs.planRefinement,
      "review-refined-plan": inputs.refinementReviewPassed,
      "confirm-plan-refinement": inputs.refinementApproved,
      // After refinement approved: continue
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
    },
  },

  // Scenario 2: Plan review finds issues, fixed
  {
    name: "Plan review issues",
    description: "Agent review finds issues in plan, fixes them",
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
      // First: agent review finds issues
      "agent-review-plan": [inputs.planReviewWithIssues, inputs.planReviewNoIssues],
      "fix-plan-issues": {},
      // After fix: continue
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
      "check-user-approval-needed": inputs.userApprovalNotNeeded,
      "validate-requirements-coverage": inputs.requirementsCoverageValid,
      "generate-final-report": inputs.finalReportGenerated,
      "present-results": inputs.userPermissionGranted,
      "collect-user-feedback": inputs.userSatisfied,
      "update-documentation": inputs.finalDocumentationUpdate,
    },
  },

  // Scenario 3: Refinement review finds issues
  {
    name: "Refinement review issues",
    description: "Refined plan review finds issues, fixes them",
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
      // Refinement review finds issues
      "review-refined-plan": [inputs.refinementReviewFailed, inputs.refinementReviewPassed],
      "fix-refined-plan-issues": {},
      "confirm-plan-refinement": inputs.refinementApproved,
      // After refinement approved: continue
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
    },
  },

  // Scenario 4: User not satisfied, plan extended
  // Flow: step 1 complete → user not satisfied → extend plan (add step 2) → step 2 complete → user satisfied
  {
    name: "Plan extension after completion",
    description: "User not satisfied after completion, additional steps added",
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
      // Step 1 + Step 2 implementation
      "create-initial-iteration-workspace": [
        inputs.standardInitialIterationWorkspace,
        inputs.standardInitialIterationWorkspace,
      ],
      "implement-step": [
        inputs.standardImplementation,
        { implemented_functionality: "Added OAuth integration" },
      ],
      "create-iteration-workspace": [
        inputs.standardIterationWorkspace,
        {
          step_results_file:
            "./moira-ws/user-auth-20251225-1200/step-2/iteration-1/step-results.md",
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
      "check-user-approval-needed": [inputs.userApprovalNotNeeded, inputs.userApprovalNotNeeded],
      "validate-requirements-coverage": inputs.requirementsCoverageValid,
      "generate-final-report": [inputs.finalReportGenerated, inputs.finalReportGeneratedV2],
      "read-prior-report": inputs.priorReportRead,
      "present-results": [inputs.userPermissionGranted, inputs.userPermissionGranted],
      // Step 1 complete → user not satisfied → extension
      // Step 2 complete → user satisfied
      "collect-user-feedback": [inputs.userNotSatisfied, inputs.userSatisfied],
      "record-user-feedback-to-requirements": inputs.userFeedbackRecorded,
      // Extension flow (after step 1)
      "create-plan-change-reasons": inputs.planChangeReasonsDocumented,
      "create-additional-steps": inputs.additionalStepsCreated,
      "review-extended-plan": inputs.extensionReviewPassed,
      "confirm-plan-extension": inputs.extensionApproved,
      "set-extension-total-steps": { total_steps: 2 }, // Now 2 steps total
      "get-next-step-name": { current_step_name: "OAuth integration" },
      // Finish
      "update-documentation": inputs.finalDocumentationUpdate,
    },
  },

  // Scenario 5: Extension review finds issues
  // Flow: step 1 → user not satisfied → extend → review fails → fix → review passes → step 2 → user satisfied
  {
    name: "Extension review issues",
    description: "Extension plan review finds issues, fixes them",
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
      // Step 1 + Step 2
      "create-initial-iteration-workspace": [
        inputs.standardInitialIterationWorkspace,
        inputs.standardInitialIterationWorkspace,
      ],
      "implement-step": [
        inputs.standardImplementation,
        { implemented_functionality: "OAuth integration" },
      ],
      "create-iteration-workspace": [
        inputs.standardIterationWorkspace,
        {
          step_results_file:
            "./moira-ws/user-auth-20251225-1200/step-2/iteration-1/step-results.md",
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
      "check-user-approval-needed": [inputs.userApprovalNotNeeded, inputs.userApprovalNotNeeded],
      "validate-requirements-coverage": inputs.requirementsCoverageValid,
      "generate-final-report": [inputs.finalReportGenerated, inputs.finalReportGeneratedV2],
      "read-prior-report": inputs.priorReportRead,
      "present-results": [inputs.userPermissionGranted, inputs.userPermissionGranted],
      // Step 1 → not satisfied, Step 2 → satisfied
      "collect-user-feedback": [inputs.userNotSatisfied, inputs.userSatisfied],
      "record-user-feedback-to-requirements": inputs.userFeedbackRecorded,
      // Extension flow with review issues
      "create-plan-change-reasons": inputs.planChangeReasonsDocumented,
      "create-additional-steps": inputs.additionalStepsCreated,
      "review-extended-plan": [inputs.extensionReviewFailed, inputs.extensionReviewPassed],
      "fix-extension-plan-issues": {},
      "confirm-plan-extension": inputs.extensionApproved,
      "set-extension-total-steps": { total_steps: 2 },
      "get-next-step-name": { current_step_name: "OAuth integration" },
      // Finish
      "update-documentation": inputs.finalDocumentationUpdate,
    },
  },

  // Scenario 6: Agent validation with plan update
  // Flow: step 1 iter 1 → agent fails (plan_needs_update) → update plan → reinitialize → step 1 iter 2 → passes → finish
  {
    name: "Agent validation with plan update",
    description: "Agent finds issues that require plan update",
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
      // Iteration 1 (fails) + Iteration 2 (after reinitialize, passes)
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
      // Iter 1: fails with plan update, Iter 2: passes
      "agent-validate-step": [
        inputs.agentValidationFailedWithPlanUpdate,
        inputs.agentValidationPassed,
      ],
      "fix-agent-feedback-issues-action": inputs.fixAgentFeedbackWithPlanUpdate,
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
      // After iter 2 passes
      "commit-step": inputs.commitStep,
      "check-user-approval-needed": inputs.userApprovalNotNeeded,
      "get-next-step-name": inputs.nextStepName,
      "validate-requirements-coverage": inputs.requirementsCoverageValid,
      "generate-final-report": inputs.finalReportGenerated,
      "present-results": inputs.userPermissionGranted,
      "collect-user-feedback": inputs.userSatisfied,
      "update-documentation": inputs.finalDocumentationUpdate,
    },
  },

  // Scenario 7: Refinement rejected, refined again
  // Flow: user rejects → refine → review passes → user rejects again → refine → user approves
  {
    name: "Refinement rejected twice",
    description: "User rejects refinement twice before approval",
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
      // User rejects plan
      "present-plan-to-user": inputs.planRejected,
      // Refine → review → confirm (rejected) → refine again → review → confirm (approved)
      "create-plan-change-reasons": [
        inputs.planChangeReasonsDocumented,
        inputs.planChangeReasonsDocumented,
      ],
      "refine-development-plan": [inputs.planRefinement, inputs.planRefinement],
      "review-refined-plan": [inputs.refinementReviewPassed, inputs.refinementReviewPassed],
      "confirm-plan-refinement": [inputs.refinementRejected, inputs.refinementApproved],
      // After second refinement approved: continue
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
    },
  },

  // Scenario 8: Extension rejected, revised
  // Flow: step 1 → user not satisfied → create-additional-steps → review → confirm (rejected) → create again → confirm (approved)
  {
    name: "Extension rejected then approved",
    description: "User rejects extension plan, revised and approved",
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
      // Step 1 + Step 2
      "create-initial-iteration-workspace": [
        inputs.standardInitialIterationWorkspace,
        inputs.standardInitialIterationWorkspace,
      ],
      "implement-step": [
        inputs.standardImplementation,
        { implemented_functionality: "Added OAuth per extended plan" },
      ],
      "create-iteration-workspace": [
        inputs.standardIterationWorkspace,
        {
          step_results_file:
            "./moira-ws/user-auth-20251225-1200/step-2/iteration-1/step-results.md",
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
      "check-user-approval-needed": [inputs.userApprovalNotNeeded, inputs.userApprovalNotNeeded],
      "validate-requirements-coverage": inputs.requirementsCoverageValid,
      "generate-final-report": [inputs.finalReportGenerated, inputs.finalReportGeneratedV2],
      "read-prior-report": inputs.priorReportRead,
      "present-results": [inputs.userPermissionGranted, inputs.userPermissionGranted],
      // Step 1 → not satisfied, Step 2 → satisfied
      "collect-user-feedback": [inputs.userNotSatisfied, inputs.userSatisfied],
      "record-user-feedback-to-requirements": inputs.userFeedbackRecorded,
      // Extension flow: create → review → confirm (rejected) → create again → review → confirm (approved)
      "create-additional-steps": [inputs.additionalStepsCreated, inputs.additionalStepsCreated],
      "review-extended-plan": [inputs.extensionReviewPassed, inputs.extensionReviewPassed],
      "confirm-plan-extension": [inputs.extensionRejected, inputs.extensionApproved],
      "create-plan-change-reasons": [
        inputs.planChangeReasonsDocumented,
        inputs.planChangeReasonsDocumented,
      ],
      "set-extension-total-steps": { total_steps: 2 },
      "get-next-step-name": { current_step_name: "OAuth integration" },
      // Finish
      "update-documentation": inputs.finalDocumentationUpdate,
    },
  },

  // Scenario 9: Plan update rejected, revised
  // Flow: agent fails → update plan → review → confirm (rejected) → update again → confirm (approved)
  {
    name: "Plan update rejected then approved",
    description: "User rejects plan update, revised and approved",
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
      // Iter 1 (fails) + Iter 2 (after reinitialize, passes)
      "create-initial-iteration-workspace": [
        inputs.standardInitialIterationWorkspace,
        inputs.standardInitialIterationWorkspace,
      ],
      "implement-step": [
        inputs.standardImplementation,
        { implemented_functionality: "Updated after plan revision" },
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
      // Iter 1: fails with plan update
      "agent-validate-step": [
        inputs.agentValidationFailedWithPlanUpdate,
        inputs.agentValidationPassed,
      ],
      "fix-agent-feedback-issues-action": inputs.fixAgentFeedbackWithPlanUpdate,
      // Plan update flow: update → review → confirm (rejected) → update again → review → confirm (approved)
      "approve-current-step-before-replan": [
        inputs.approveCurrentStepBeforeReplan,
        inputs.approveCurrentStepBeforeReplan,
      ],
      "update-plan-during-execution": [
        inputs.planUpdateDuringExecution,
        inputs.planUpdateDuringExecution,
      ],
      "review-updated-plan": [inputs.planUpdateReviewPassed, inputs.planUpdateReviewPassed],
      "confirm-plan-update": [inputs.planUpdateRejected, inputs.planUpdateApproved],
      "create-plan-change-reasons": [
        inputs.planChangeReasonsDocumented,
        inputs.planChangeReasonsDocumented,
      ],
      "set-update-total-steps": { total_steps: 2 },
      "reinitialize-plan-tracking": {
        tracking_reinitialized: "yes",
      },
      // After iter 2 passes
      "commit-step": inputs.commitStep,
      "check-user-approval-needed": inputs.userApprovalNotNeeded,
      "get-next-step-name": inputs.nextStepName,
      "validate-requirements-coverage": inputs.requirementsCoverageValid,
      "generate-final-report": inputs.finalReportGenerated,
      "present-results": inputs.userPermissionGranted,
      "collect-user-feedback": inputs.userSatisfied,
      "update-documentation": inputs.finalDocumentationUpdate,
    },
  },

  // Scenario 10: Plan update review finds issues
  // Flow: step 1 → agent fails → update plan → review fails → fix → review passes → reinitialize → iter 2 → passes
  {
    name: "Plan update review issues",
    description: "Updated plan review finds issues, fixes them",
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
      // Iter 1 + Iter 2
      "create-initial-iteration-workspace": [
        inputs.standardInitialIterationWorkspace,
        inputs.standardInitialIterationWorkspace,
      ],
      "implement-step": [
        inputs.standardImplementation,
        { implemented_functionality: "Updated after plan fix" },
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
      // Iter 1: fails, Iter 2: passes
      "agent-validate-step": [
        inputs.agentValidationFailedWithPlanUpdate,
        inputs.agentValidationPassed,
      ],
      "fix-agent-feedback-issues-action": inputs.fixAgentFeedbackWithPlanUpdate,
      "approve-current-step-before-replan": inputs.approveCurrentStepBeforeReplan,
      "create-plan-change-reasons": inputs.planChangeReasonsDocumented,
      "update-plan-during-execution": inputs.planUpdateDuringExecution,
      // Update review fails then passes
      "review-updated-plan": [inputs.planUpdateReviewFailed, inputs.planUpdateReviewPassed],
      "fix-updated-plan-issues": {},
      "confirm-plan-update": inputs.planUpdateApproved,
      "set-update-total-steps": { total_steps: 2 },
      "reinitialize-plan-tracking": {
        tracking_reinitialized: "yes",
      },
      // Finish after iter 2 passes
      "commit-step": inputs.commitStep,
      "check-user-approval-needed": inputs.userApprovalNotNeeded,
      "get-next-step-name": inputs.nextStepName,
      "validate-requirements-coverage": inputs.requirementsCoverageValid,
      "generate-final-report": inputs.finalReportGenerated,
      "present-results": inputs.userPermissionGranted,
      "collect-user-feedback": inputs.userSatisfied,
      "update-documentation": inputs.finalDocumentationUpdate,
    },
  },

  // Scenario 11: Plan update with step increment
  // Tests: reinitialize-plan-tracking → expr-increment-after-plan-update → implement-step (next step)
  // Flow: step 1 iter 1 → agent fails → update plan (adds step 2) → reinitialize → auto-increment → step 2 → passes
  {
    name: "Plan update with automatic step increment",
    description:
      "After plan update, current_step_index is automatically incremented to move to next step",
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
      // Step 1 iteration 1 (fails with plan update) + Step 2 (after increment, passes)
      "create-initial-iteration-workspace": [
        inputs.standardInitialIterationWorkspace,
        inputs.standardInitialIterationWorkspace,
      ],
      "implement-step": [
        inputs.standardImplementation,
        { implemented_functionality: "Completed step 2 after plan update" },
      ],
      "create-iteration-workspace": [
        inputs.standardIterationWorkspace,
        {
          step_results_file:
            "./moira-ws/user-auth-20251225-1200/step-2/iteration-1/step-results.md",
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
      // Step 1: fails with plan update, Step 2: passes
      "agent-validate-step": [
        inputs.agentValidationFailedWithPlanUpdate,
        inputs.agentValidationPassed,
      ],
      "fix-agent-feedback-issues-action": inputs.fixAgentFeedbackWithPlanUpdate,
      // Plan update flow - adds step 2
      "approve-current-step-before-replan": inputs.approveCurrentStepBeforeReplan,
      "create-plan-change-reasons": inputs.planChangeReasonsDocumented,
      "update-plan-during-execution": {
        plan_changes_description: "Added step 2 for OAuth integration",
      },
      "review-updated-plan": inputs.planUpdateReviewPassed,
      "confirm-plan-update": inputs.planUpdateApproved,
      "set-update-total-steps": { total_steps: 2 },
      // After reinitialize, expr-increment-after-plan-update increments current_step_index
      // So we move from step 1 to step 2
      "reinitialize-plan-tracking": {
        tracking_reinitialized: "yes",
      },
      // Step 2 completes successfully
      "commit-step": inputs.commitStep,
      "check-user-approval-needed": inputs.userApprovalNotNeeded,
      "get-next-step-name": inputs.nextStepName,
      "validate-requirements-coverage": inputs.requirementsCoverageValid,
      "generate-final-report": inputs.finalReportGenerated,
      "present-results": inputs.userPermissionGranted,
      "collect-user-feedback": inputs.userSatisfied,
      "update-documentation": inputs.finalDocumentationUpdate,
    },
  },
];
