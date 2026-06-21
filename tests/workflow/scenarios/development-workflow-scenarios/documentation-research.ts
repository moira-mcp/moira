/**
 * Documentation and Research Scenarios for software-development-flow
 *
 * Tests documentation-only and research-only change paths.
 */

import type { TestScenario } from "../../../helpers/scenario-runner.js";
import * as inputs from "./base-inputs.js";

export const documentationResearchScenarios: TestScenario[] = [
  // Scenario 1: Documentation-only changes
  {
    name: "Documentation only changes",
    description: "Changes only affect documentation, skip code-related checks",
    expect: { status: "completed" },
    mockInputs: {
      ...inputs.standardPipeline,
      "get-task-requirements": {
        user_task_description: "Update API documentation with new endpoints and examples",
        task_complexity_in_context: 5,
        github_issues: "",
      },
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": {
        workspace_path: "./moira-ws/docs-update-20251225-1200/",
        feature_name: "docs-update",
        process_id_file_created: true,
      },
      "create-workspace-files": {
        files_created: true,
        task_requirements_file: "./moira-ws/docs-update-20251225-1200/task-requirements.md",
      },
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": {
        plan_summary: "Single-step documentation update task to improve API reference materials",
        development_plan_file: "./moira-ws/docs-update-20251225-1200/development-plan.md",
        total_steps: 1,
      },
      "agent-review-plan": inputs.planReviewNoIssues,
      "present-plan-to-user": inputs.planApproved,
      "initialize-plan-tracking": { current_step_name: "Update docs", total_steps: 1 },
      "initial-system-startup": inputs.initialSystemStartup,
      "initial-run-tests": inputs.initialTestsRun,
      "create-initial-iteration-workspace": inputs.standardInitialIterationWorkspace,
      "implement-step": { implemented_functionality: "Updated API documentation" },
      "create-iteration-workspace": {
        step_results_file:
          "./moira-ws/docs-update-20251225-1200/step-1/iteration-1/step-results.md",
      },
      "restart-and-rebuild": inputs.startupSuccess,
      // Documentation-only path
      "analyze-implementation-changes": inputs.documentationOnlyChanges,
      "validate-documentation": inputs.documentationValid,
      // Skip code-related checks, go directly to documentation
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

  // Scenario 2: Research-only changes
  {
    name: "Research only changes",
    description: "Changes are research/analysis only, no code modifications",
    expect: { status: "completed" },
    mockInputs: {
      ...inputs.standardPipeline,
      "get-task-requirements": {
        user_task_description: "Research authentication best practices and document findings",
        task_complexity_in_context: 5,
        github_issues: "",
      },
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": {
        workspace_path: "./moira-ws/auth-research-20251225-1200/",
        feature_name: "auth-research",
        process_id_file_created: true,
      },
      "create-workspace-files": {
        files_created: true,
        task_requirements_file: "./moira-ws/auth-research-20251225-1200/task-requirements.md",
      },
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": {
        plan_summary: "Single-step research task to evaluate authentication implementation options",
        development_plan_file: "./moira-ws/auth-research-20251225-1200/development-plan.md",
        total_steps: 1,
      },
      "agent-review-plan": inputs.planReviewNoIssues,
      "present-plan-to-user": inputs.planApproved,
      "initialize-plan-tracking": { current_step_name: "Research", total_steps: 1 },
      "initial-system-startup": inputs.initialSystemStartup,
      "initial-run-tests": inputs.initialTestsRun,
      "create-initial-iteration-workspace": inputs.standardInitialIterationWorkspace,
      "implement-step": {
        implemented_functionality: "Researched auth patterns and documented findings",
      },
      "create-iteration-workspace": {
        step_results_file:
          "./moira-ws/auth-research-20251225-1200/step-1/iteration-1/step-results.md",
      },
      "restart-and-rebuild": inputs.startupSuccess,
      // Research-only path
      "analyze-implementation-changes": inputs.researchOnlyChanges,
      // Skip all code checks
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

  // Scenario 3: Tests-only changes
  // Flow: tests_only → assess-testing-needs → (no new tests) → update-step-documentation → ...
  {
    name: "Tests only changes",
    description: "Changes only affect tests, skip functionality checks",
    expect: { status: "completed" },
    mockInputs: {
      ...inputs.standardPipeline,
      "get-task-requirements": {
        user_task_description: "Add missing unit tests for auth module and improve coverage",
        task_complexity_in_context: 5,
        github_issues: "#456",
      },
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": {
        workspace_path: "./moira-ws/auth-tests-20251225-1200/",
        feature_name: "auth-tests",
        process_id_file_created: true,
      },
      "create-workspace-files": {
        files_created: true,
        task_requirements_file: "./moira-ws/auth-tests-20251225-1200/task-requirements.md",
      },
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": {
        plan_summary: "Single-step task to add missing unit tests and improve auth module coverage",
        development_plan_file: "./moira-ws/auth-tests-20251225-1200/development-plan.md",
        total_steps: 1,
      },
      "agent-review-plan": inputs.planReviewNoIssues,
      "present-plan-to-user": inputs.planApproved,
      "initialize-plan-tracking": { current_step_name: "Add tests", total_steps: 1 },
      "initial-system-startup": inputs.initialSystemStartup,
      "initial-run-tests": inputs.initialTestsRun,
      "create-initial-iteration-workspace": inputs.standardInitialIterationWorkspace,
      "implement-step": { implemented_functionality: "Added 15 unit tests for auth module" },
      "create-iteration-workspace": {
        step_results_file: "./moira-ws/auth-tests-20251225-1200/step-1/iteration-1/step-results.md",
      },
      // Tests-only path: analyze → route-by-change-type:false → route-non-code-changes:true → assess-testing-needs
      "analyze-implementation-changes": inputs.testsOnlyChanges,
      // Tests already written, no new tests needed
      "assess-testing-needs": inputs.noNewTestsRequired,
      // route-skip-run-tests:true (test_info != "skip") → run-all-tests
      "run-all-tests": inputs.allTestsPass,
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

  // Scenario 4: Documentation changes without standards
  // Flow: documentation_only → route-has-docs-standards:false → commit-step (skip validation)
  {
    name: "Documentation without standards",
    description: "Documentation changes in project without doc standards, skip validation",
    expect: { status: "completed" },
    mockInputs: {
      // Use noDocsStandardsProjectInfo to set documentation_standards = "not_found"
      ...inputs.artifactDiscoveryNoDocs,
      ...inputs.gitOpsCleanRepo,
      ...inputs.workspaceSetup,
      "ask-user-docs-standards": inputs.userDeclinesDocsStandards,
      "get-task-requirements": {
        user_task_description: "Add inline comments to clarify complex code",
        task_complexity_in_context: 5,
        github_issues: "",
      },
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": {
        workspace_path: "./moira-ws/code-comments-20251225-1200/",
        feature_name: "code-comments",
        process_id_file_created: true,
      },
      "create-workspace-files": {
        files_created: true,
        task_requirements_file: "./moira-ws/code-comments-20251225-1200/task-requirements.md",
      },
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": {
        plan_summary: "Single-step task to add clarifying comments throughout the codebase",
        development_plan_file: "./moira-ws/code-comments-20251225-1200/development-plan.md",
        total_steps: 1,
      },
      "agent-review-plan": inputs.planReviewNoIssues,
      "present-plan-to-user": inputs.planApproved,
      "initialize-plan-tracking": { current_step_name: "Add comments", total_steps: 1 },
      "initial-system-startup": inputs.initialSystemStartup,
      "initial-run-tests": inputs.initialTestsRun,
      "create-initial-iteration-workspace": inputs.standardInitialIterationWorkspace,
      "implement-step": { implemented_functionality: "Added inline comments" },
      "create-iteration-workspace": {
        step_results_file:
          "./moira-ws/code-comments-20251225-1200/step-1/iteration-1/step-results.md",
      },
      "restart-and-rebuild": inputs.startupSuccess,
      // Documentation-only + no docs standards → route-has-docs-standards:false → skip validate-documentation
      "analyze-implementation-changes": inputs.documentationOnlyChanges,
      // Skip validate-documentation, go directly to commit-step
      "commit-step": inputs.commitStep,
      "check-user-approval-needed": inputs.userApprovalNotNeeded,
      "validate-requirements-coverage": inputs.requirementsCoverageValid,
      "generate-final-report": inputs.finalReportGenerated,
      "present-results": inputs.userPermissionGranted,
      "collect-user-feedback": inputs.userSatisfied,
      "update-documentation": inputs.finalDocumentationUpdate,
    },
  },

  // Scenario 5: Documentation with validation issues
  {
    name: "Documentation with issues",
    description: "Documentation changes have issues that need fixing",
    expect: { status: "completed" },
    mockInputs: {
      ...inputs.standardPipeline,
      "get-task-requirements": {
        user_task_description: "Rewrite README file with improved structure and examples",
        task_complexity_in_context: 5,
        github_issues: "",
      },
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": {
        workspace_path: "./moira-ws/readme-rewrite-20251225-1200/",
        feature_name: "readme-rewrite",
        process_id_file_created: true,
      },
      "create-workspace-files": {
        files_created: true,
        task_requirements_file: "./moira-ws/readme-rewrite-20251225-1200/task-requirements.md",
      },
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": {
        plan_summary: "Single-step task to completely rewrite README with better organization",
        development_plan_file: "./moira-ws/readme-rewrite-20251225-1200/development-plan.md",
        total_steps: 1,
      },
      "agent-review-plan": inputs.planReviewNoIssues,
      "present-plan-to-user": inputs.planApproved,
      "initialize-plan-tracking": { current_step_name: "Rewrite README", total_steps: 1 },
      "initial-system-startup": inputs.initialSystemStartup,
      "initial-run-tests": inputs.initialTestsRun,
      "create-initial-iteration-workspace": inputs.standardInitialIterationWorkspace,
      "implement-step": { implemented_functionality: "Rewrote README" },
      "create-iteration-workspace": [
        {
          step_results_file:
            "./moira-ws/readme-rewrite-20251225-1200/step-1/iteration-1/step-results.md",
        },
        {
          step_results_file:
            "./moira-ws/readme-rewrite-20251225-1200/step-1/iteration-2/step-results.md",
        },
      ],
      "restart-and-rebuild": inputs.startupSuccess,
      "analyze-implementation-changes": inputs.documentationOnlyChanges,
      // Documentation validation fails first
      "validate-documentation": [inputs.documentationInvalid, inputs.documentationValid],
      "fix-documentation-issues": inputs.documentationFixed,
      "check-documentation-fixes-complete": inputs.documentationFixesDocumented,
      // After fix
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

  // Scenario 6: Documentation partial fix → check-documentation-fixes-complete:false branch
  {
    name: "Documentation partial fix loop",
    description:
      "Doc issues partially fixed on first attempt, check-documentation-fixes-complete:false triggers re-iteration",
    expect: { status: "completed", maxSteps: 150 },
    mockInputs: {
      ...inputs.standardPipeline,
      "get-task-requirements": {
        user_task_description: "Rewrite README file with improved structure and examples",
        task_complexity_in_context: 5,
        github_issues: "",
      },
      "study-project-foundation": inputs.standardProjectFoundation,
      "study-implementation-details": inputs.standardImplementationDetails,
      "create-feature-workspace": {
        workspace_path: "./moira-ws/readme-rewrite-20251225-1200/",
        feature_name: "readme-rewrite",
        process_id_file_created: true,
      },
      "create-workspace-files": {
        files_created: true,
        task_requirements_file: "./moira-ws/readme-rewrite-20251225-1200/task-requirements.md",
      },
      "present-requirements-confirmation": inputs.requirementsConfirmed,
      "ask-screenshot-validation": inputs.screenshotValidationDisabled,
      "analyze-and-plan": {
        plan_summary: "Single-step task to completely rewrite README with better organization",
        development_plan_file: "./moira-ws/readme-rewrite-20251225-1200/development-plan.md",
        total_steps: 1,
      },
      "agent-review-plan": inputs.planReviewNoIssues,
      "present-plan-to-user": inputs.planApproved,
      "initialize-plan-tracking": { current_step_name: "Rewrite README", total_steps: 1 },
      "initial-system-startup": inputs.initialSystemStartup,
      "initial-run-tests": inputs.initialTestsRun,
      "create-initial-iteration-workspace": inputs.standardInitialIterationWorkspace,
      "implement-step": { implemented_functionality: "Rewrote README" },
      "create-iteration-workspace": [
        {
          step_results_file:
            "./moira-ws/readme-rewrite-20251225-1200/step-1/iteration-1/step-results.md",
        },
        {
          step_results_file:
            "./moira-ws/readme-rewrite-20251225-1200/step-1/iteration-2/step-results.md",
        },
      ],
      "restart-and-rebuild": inputs.startupSuccess,
      "analyze-implementation-changes": inputs.documentationOnlyChanges,
      // Iteration 1: doc validation finds 3 issues, partial fix (1 of 3)
      "validate-documentation": [
        {
          expected_doc_issues: 3,
          documentation_issues_summary: "Missing API docs, bad formatting, outdated examples",
        },
        // Iteration 2: all issues resolved
        { expected_doc_issues: 0, documentation_issues_summary: "No documentation issues" },
      ],
      // Only called once (iteration 1) since iteration 2 has 0 issues
      "fix-documentation-issues": {
        fixed_doc_issues: 1,
        documentation_fixes: "Fixed one of three doc issues",
      },
      // check-documentation-fixes-complete: 1 eq 3 → false → expr-increment-iteration → loop
      "read-prior-iteration-results": inputs.priorIterationResultsRead,
      // After iteration 2: doc validation passes → continue
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
];
