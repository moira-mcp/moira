/**
 * Base Mock Inputs for software-development-flow
 *
 * Common input patterns reused across scenarios.
 * Production workflow v7.41.0: 182 nodes, 89 agent-directive nodes with inputSchema.
 */

// === Artifact search results (per-artifact pipeline) ===

/** All artifacts found - standard search results */
export const searchTestInfoFound = {
  test_info_path: "./tests/TESTING-GUIDE.md",
  search_strategies_used:
    "1. grep -ri test README.md — found section. 2. find . -name TESTING* — found tests/TESTING-GUIDE.md. 3. ls tests/ — contains utils/, unit/, e2e/",
};

export const searchDocsStandardsFound = {
  documentation_standards_path: "./docs/DOCUMENTATION-STYLE-GUIDE.md",
  search_strategies_used:
    "1. find . -name *STYLE* — found docs/DOCUMENTATION-STYLE-GUIDE.md. 2. grep -ri documentation docs/ — multiple hits. 3. ls docs/ — contains style guide",
};

export const searchBrowserUIFound = {
  browser_ui_info_path: "./packages/web-ui/package.json",
  search_strategies_used:
    "1. find . -name package.json -path */web* — found web-ui. 2. ls packages/ — contains web-ui/. 3. grep -ri browser packages/web-ui/ — found config",
};

export const searchChecklistFound = {
  project_checklist_path: "./docs/PROJECT_CHECKLIST.md",
  search_strategies_used:
    "1. find . -name *CHECKLIST* — found docs/PROJECT_CHECKLIST.md. 2. grep -ri checklist docs/ — hit. 3. ls docs/ — visible in listing",
};

export const searchStartupInfoFound = {
  startup_info_path: "./docs/DEVELOPMENT.md",
  search_strategies_used:
    "1. grep -ri startup docs/ — found DEVELOPMENT.md. 2. find . -name DEVELOPMENT* — found. 3. ls docs/ — contains DEVELOPMENT.md",
};

export const searchOnboardingInfoFound = {
  agent_onboarding_file_path: "./CLAUDE.md",
  search_strategies_used:
    "1. ls . — found CLAUDE.md in root. 2. grep -ri onboarding . — found CLAUDE.md. 3. find . -name CLAUDE* — found ./CLAUDE.md",
};

export const searchScreenshotGuideFound = {
  screenshot_guide_path: "./docs/SCREENSHOT-GUIDE.md",
  search_strategies_used:
    "1. find . -name *screenshot* — found docs/SCREENSHOT-GUIDE.md. 2. grep -ri screenshot docs/ — hit. 3. ls docs/ — visible in listing",
};

/** Not found variants */
export const searchTestInfoNotFound = {
  test_info_path: "not_found",
  search_strategies_used:
    "1. grep -ri test README.md — no testing section. 2. find . -name TESTING* — no results. 3. ls tests/ — directory not found",
};

export const searchDocsStandardsNotFound = {
  documentation_standards_path: "not_found",
  search_strategies_used:
    "1. find . -name *STYLE* — no results. 2. grep -ri documentation-standard . — no results. 3. ls docs/ — no style guide file",
};

export const searchBrowserUINotFound = {
  browser_ui_info_path: "not_found",
  search_strategies_used:
    "1. find . -name package.json -path */web* — no results. 2. ls packages/ — no web-ui directory. 3. grep -ri browser-ui . — no results",
};

export const searchChecklistNotFound = {
  project_checklist_path: "not_found",
  search_strategies_used:
    "1. find . -name *CHECKLIST* — no results. 2. grep -ri checklist . — no results. 3. ls docs/ — no checklist file",
};

export const searchStartupInfoNotFound = {
  startup_info_path: "not_found",
  search_strategies_used:
    "1. grep -ri startup docs/ — no results. 2. find . -name DEVELOPMENT* — no results. 3. ls docs/ — no startup/development file",
};

export const searchOnboardingInfoNotFound = {
  agent_onboarding_file_path: "not_found",
  search_strategies_used:
    "1. ls . — no CLAUDE.md. 2. grep -ri onboarding . — no results. 3. find . -name *onboard* — no results",
};

export const searchScreenshotGuideNotFound = {
  screenshot_guide_path: "not_found",
  search_strategies_used:
    "1. find . -name *screenshot* — no results. 2. grep -ri screenshot docs/ — no results. 3. ls docs/ — no screenshot guide",
};

// === Create node outputs (when user says "yes" at ask-user-* nodes) ===

export const createTestInfo = {
  test_info_path: "./tests/TESTING-GUIDE.md",
};

export const createDocsStandards = {
  documentation_standards_path: "./docs/DOCUMENTATION-STYLE-GUIDE.md",
};

export const createBrowserUI = {
  browser_ui_info_path: "./docs/BROWSER-UI-STANDARDS.md",
};

export const createChecklist = {
  project_checklist_path: "./docs/PROJECT_CHECKLIST.md",
};

export const createStartupInfo = {
  startup_info_path: "./docs/STARTUP-GUIDE.md",
};

export const createOnboardingInfo = {
  agent_onboarding_file_path: "./docs/AGENT-ONBOARDING.md",
};

export const createScreenshotGuide = {
  screenshot_guide_path: "./docs/screenshot-guide.md",
};

// === Present-approve-collect pipeline (after create-* nodes) ===

/** User approves presented artifact */
export const approveArtifact = {
  decision: "approve",
};

/** User rejects presented artifact (triggers re-creation loop) */
export const rejectArtifact = {
  decision: "reject",
};

/** Collect path inputs per artifact (re-confirms path after approval) */
export const collectTestInfoPath = {
  test_info_path: "./tests/TESTING-GUIDE.md",
};

export const collectDocsStandardsPath = {
  documentation_standards_path: "./docs/DOCUMENTATION-STYLE-GUIDE.md",
};

export const collectBrowserUIPath = {
  browser_ui_info_path: "./docs/BROWSER-UI-STANDARDS.md",
};

export const collectChecklistPath = {
  project_checklist_path: "./docs/PROJECT_CHECKLIST.md",
};

export const collectStartupInfoPath = {
  startup_info_path: "./docs/STARTUP-GUIDE.md",
};

export const collectOnboardingInfoPath = {
  agent_onboarding_file_path: "./docs/AGENT-ONBOARDING.md",
};

export const collectScreenshotGuidePath = {
  screenshot_guide_path: "./docs/screenshot-guide.md",
};

// === User question responses for per-artifact pipeline ===

/**
 * User declines test creation
 */
export const userDeclinesTests = {
  user_wants_test_info: "no",
};

/**
 * User requests test creation
 */
export const userRequestsTests = {
  user_wants_test_info: "yes",
};

/**
 * User declines documentation standards
 */
export const userDeclinesDocsStandards = {
  user_wants_docs_standards: "no",
};

/**
 * User creates documentation standards
 */
export const userCreatesDocsStandards = {
  user_wants_docs_standards: "yes",
};

/**
 * User declines browser UI
 */
export const userDeclinesBrowserUI = {
  user_wants_browser_ui: "no",
};

/**
 * User requests browser UI
 */
export const userRequestsBrowserUI = {
  user_wants_browser_ui: "yes",
};

/**
 * User declines checklist creation
 */
export const userDeclinesChecklist = {
  user_wants_checklist: "no",
};

/**
 * User declines startup info creation
 */
export const userDeclinesStartupInfo = {
  user_wants_startup_info: "no",
};

/**
 * User declines onboarding document creation
 */
export const userDeclinesOnboarding = {
  user_wants_onboarding_info: "no",
};

/**
 * Standard task requirements
 * Note: task_complexity_in_context is 1-10 (1-4: express mode, 5-10: full development)
 */
export const standardTaskRequirements = {
  user_task_description: "Implement user authentication feature with login and logout endpoints",
  task_complexity_in_context: 7, // Full development mode
  github_issues: "#123",
};

/**
 * Simple task (for express mode)
 * Note: workflow checks task_complexity_in_context < 2 for express mode
 */
export const simpleTaskRequirements = {
  user_task_description: "Fix typo in README file line 42",
  task_complexity_in_context: 1, // Express mode (< 2)
  github_issues: "",
};

// === Project Study (Phase 1: foundation + implementation details) ===

/**
 * Standard project foundation study results (empty schema — no properties)
 */
export const standardProjectFoundation = {};

/**
 * Standard implementation details study results (empty schema — no properties)
 */
export const standardImplementationDetails = {};

/**
 * Standard feature workspace creation
 * Note: workspace_path, feature_name, git_enabled are SET as context variables
 * Note: feature_name is auto-generated from task description (no user confirmation)
 */
export const standardFeatureWorkspace = {
  workspace_path: "./moira-ws/user-auth-20251225-1200/",
  feature_name: "user-auth",
  process_id_file_created: true,
};

/**
 * Feature workspace with git init (no .git existed, user said yes to create)
 */
export const gitInitFeatureWorkspace = {
  workspace_path: "./moira-ws/user-auth-20251225-1200/",
  feature_name: "user-auth",
  process_id_file_created: true,
};

/**
 * Feature workspace without git (user chose to skip git)
 * Used for git skip pattern testing
 */
export const noGitFeatureWorkspace = {
  workspace_path: "./moira-ws/user-auth-20251225-1200/",
  feature_name: "user-auth",
  process_id_file_created: true,
};

/**
 * Feature workspace with git commit (dirty state, user chose commit)
 */
export const gitCommitFeatureWorkspace = {
  workspace_path: "./moira-ws/user-auth-20251225-1200/",
  feature_name: "user-auth",
  process_id_file_created: true,
};

/**
 * Feature workspace with git stash (dirty state, user chose stash)
 */
export const gitStashFeatureWorkspace = {
  workspace_path: "./moira-ws/user-auth-20251225-1200/",
  feature_name: "user-auth",
  process_id_file_created: true,
};

// === Git Branch Setup ===

/**
 * Standard git branch created
 */
export const standardGitBranch = {
  branch_created: true,
};

/**
 * Git cleanup - tree was already clean
 */
export const gitCleanupNone = {
  cleanup_action: "none_clean",
};

/**
 * Git cleanup - user committed changes
 */
export const gitCleanupCommit = {
  cleanup_action: "commit",
};

/**
 * Git cleanup - user stashed changes
 */
export const gitCleanupStash = {
  cleanup_action: "stash",
};

/**
 * Git cleanup - user reset changes
 */
export const gitCleanupReset = {
  cleanup_action: "reset",
};

// === Workspace Files Creation (new node: create-workspace-files) ===

/**
 * Standard workspace files created
 */
export const standardWorkspaceFiles = {
  files_created: true,
  task_requirements_file: "./moira-ws/user-auth-20251225-1200/task-requirements.md",
};

// === Requirements Confirmation (Step 2 addition) ===

/**
 * Requirements confirmed by user
 */
export const requirementsConfirmed = {
  requirements_confirmed: true,
  user_feedback: "confirmed",
};

/**
 * Requirements rejected by user - needs changes
 */
export const requirementsRejected = {
  requirements_confirmed: false,
  user_feedback: "Missing error handling requirements and rate limiting details",
};

/**
 * Requirements clarification after rejection
 */
export const requirementsClarified = {};

// === Screenshot Validation (Step 5 addition) ===

/**
 * Screenshot validation disabled (default for most scenarios)
 */
export const screenshotValidationDisabled = {
  screenshot_validation_enabled: "no",
};

/**
 * Screenshot validation enabled
 */
export const screenshotValidationEnabled = {
  screenshot_validation_enabled: "yes",
};

/**
 * Screenshot infrastructure setup complete
 */
export const screenshotInfrastructureReady = {
  screenshot_guide_path: "./docs/screenshot-guide.md",
};

export const screenshotInfrastructureNotFound = {
  screenshot_guide_path: "not_found",
};

// Alias used by some scenarios
export const screenshotGuideNotFound = screenshotInfrastructureNotFound;

export const userWantsScreenshotGuide = {
  user_wants_screenshot_guide: "yes",
};

export const userDeclinesScreenshotGuide = {
  user_wants_screenshot_guide: "no",
};

export const screenshotGuideCreated = {
  screenshot_guide_path: "./docs/screenshot-guide.md",
};

// Alias used by some scenarios
export const screenshotInfrastructureCreated = screenshotGuideCreated;

/** GitHub issues fetched */
export const fetchGithubIssues = {
  issues_fetched: true,
};

export const userCreatesChecklist = {
  user_wants_checklist: "yes",
};

export const userCreatesStartupInfo = {
  user_wants_startup_info: "yes",
};

export const userCreatesOnboardingInfo = {
  user_wants_onboarding_info: "yes",
};

// === Artifact Discovery Pipeline Composites ===

/** Standard artifact discovery pipeline - all artifacts found */
export const artifactDiscoveryAllFound = {
  "search-test-info": searchTestInfoFound,
  "search-docs-standards": searchDocsStandardsFound,
  "search-browser-ui": searchBrowserUIFound,
  "search-checklist": searchChecklistFound,
  "search-startup-info": searchStartupInfoFound,
  "search-onboarding-info": searchOnboardingInfoFound,
  "search-screenshot-guide": searchScreenshotGuideFound,
};

/** Test info not found, user declines creation */
export const artifactDiscoveryNoTests = {
  "search-test-info": searchTestInfoNotFound,
  "ask-user-test-info": userDeclinesTests,
  "search-docs-standards": searchDocsStandardsFound,
  "search-browser-ui": searchBrowserUIFound,
  "search-checklist": searchChecklistFound,
  "search-startup-info": searchStartupInfoFound,
  "search-onboarding-info": searchOnboardingInfoFound,
  "search-screenshot-guide": searchScreenshotGuideFound,
};

/** Docs standards not found, user declines creation */
export const artifactDiscoveryNoDocs = {
  "search-test-info": searchTestInfoFound,
  "search-docs-standards": searchDocsStandardsNotFound,
  "ask-user-docs-standards": userDeclinesDocsStandards,
  "search-browser-ui": searchBrowserUIFound,
  "search-checklist": searchChecklistFound,
  "search-startup-info": searchStartupInfoFound,
  "search-onboarding-info": searchOnboardingInfoFound,
  "search-screenshot-guide": searchScreenshotGuideFound,
};

/** Browser UI not found, user declines creation */
export const artifactDiscoveryNoBrowser = {
  "search-test-info": searchTestInfoFound,
  "search-docs-standards": searchDocsStandardsFound,
  "search-browser-ui": searchBrowserUINotFound,
  "ask-user-browser-ui": userDeclinesBrowserUI,
  "search-checklist": searchChecklistFound,
  "search-startup-info": searchStartupInfoFound,
  "search-onboarding-info": searchOnboardingInfoFound,
  "search-screenshot-guide": searchScreenshotGuideFound,
};

/** Checklist not found, user declines creation */
export const artifactDiscoveryNoChecklist = {
  "search-test-info": searchTestInfoFound,
  "search-docs-standards": searchDocsStandardsFound,
  "search-browser-ui": searchBrowserUIFound,
  "search-checklist": searchChecklistNotFound,
  "ask-user-checklist": userDeclinesChecklist,
  "search-startup-info": searchStartupInfoFound,
  "search-onboarding-info": searchOnboardingInfoFound,
  "search-screenshot-guide": searchScreenshotGuideFound,
};

/** All artifacts not found, all declined */
export const artifactDiscoveryAllNotFound = {
  "search-test-info": searchTestInfoNotFound,
  "ask-user-test-info": userDeclinesTests,
  "search-docs-standards": searchDocsStandardsNotFound,
  "ask-user-docs-standards": userDeclinesDocsStandards,
  "search-browser-ui": searchBrowserUINotFound,
  "ask-user-browser-ui": userDeclinesBrowserUI,
  "search-checklist": searchChecklistNotFound,
  "ask-user-checklist": userDeclinesChecklist,
  "search-startup-info": searchStartupInfoNotFound,
  "ask-user-startup-info": userDeclinesStartupInfo,
  "search-onboarding-info": searchOnboardingInfoNotFound,
  "ask-user-onboarding-info": userDeclinesOnboarding,
  "search-screenshot-guide": searchScreenshotGuideNotFound,
  "ask-user-screenshot-guide": userDeclinesScreenshotGuide,
};

// === Git Operations Composites ===

/** Git repo exists, clean state → branch created, cleanup none */
export const gitOpsCleanRepo = {
  "check-git-status": { git_repo_exists: true },
  "git-create-branch": { branch_created: true },
  "git-cleanup-dirty-state": { cleanup_action: "none_clean" },
};

/** No git repo, user skips init */
export const gitOpsNoGit = {
  "check-git-status": { git_repo_exists: false },
  "git-ask-init": { git_action_taken: "skip" },
};

/** Git repo exists, dirty state, user commits during cleanup */
export const gitOpsDirtyCommit = {
  "check-git-status": { git_repo_exists: true },
  "git-create-branch": { branch_created: true },
  "git-cleanup-dirty-state": { cleanup_action: "commit" },
};

/** @deprecated Use gitOpsDirtyCommit — dirty+continue path removed in v9.2.0 */
export const gitOpsDirtyContinue = gitOpsDirtyCommit;

/** @deprecated Use gitOpsDirtyContinue — "skip" was renamed to "continue" in v9.1.0 */
export const gitOpsDirtySkip = gitOpsDirtyCommit;

/** Git repo exists, dirty state, user stashes during cleanup */
export const gitOpsDirtyStash = {
  "check-git-status": { git_repo_exists: true },
  "git-create-branch": { branch_created: true },
  "git-cleanup-dirty-state": { cleanup_action: "stash" },
};

/** No git repo, user chooses to init */
export const gitOpsNoGitInit = {
  "check-git-status": { git_repo_exists: false },
  "git-ask-init": { git_action_taken: "init" },
  "git-create-branch": { branch_created: true },
  "git-cleanup-dirty-state": { cleanup_action: "none_clean" },
};

// === Workspace Setup ===

/** Standard workspace files and planning standards creation */
export const workspaceSetup = {
  "create-workspace-files": {
    files_created: true,
    task_requirements_file: "./task-requirements.md",
  },
  "create-planning-standards": { planning_standards_created: true },
  "fetch-github-issues": { issues_fetched: true },
};

// === Standard Pipeline (artifact discovery + git + workspace) ===

/** Complete standard pipeline: all artifacts found, clean git, workspace created */
export const standardPipeline = {
  ...artifactDiscoveryAllFound,
  ...gitOpsCleanRepo,
  ...workspaceSetup,
};

/**
 * Screenshot validation passed (0 issues)
 */
export const screenshotValidationPassed = {
  screenshot_issues_count: 0,
  screenshots_captured: 5,
};

/**
 * Screenshot validation failed (issues found)
 */
export const screenshotValidationFailed = {
  screenshot_issues_count: 3,
  screenshots_captured: 5,
};

/**
 * Screenshot issues fixed
 */
export const screenshotIssuesFixed = {
  screenshot_issues_fixed: "yes",
};

/**
 * Screenshot report generated
 */
export const screenshotReportGenerated = {
  screenshot_report_path:
    "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/screenshot-report.html",
  screenshots_in_report: 5,
};

/**
 * Screenshot fixes documented (before iteration increment)
 */
export const screenshotFixesDocumented = {
  fixes_summary:
    "Fixed 3 screenshot validation issues: button alignment, modal overlap, and dark mode contrast",
};

/**
 * Plan change reasons documented
 */
export const planChangeReasonsDocumented = {
  reasons_summary: "Plan needs refinement due to reviewer feedback on missing edge cases",
};

/**
 * Rework context saved (teleport replan flow)
 */
export const reworkContextSaved = {};

/**
 * Has UI changes (for screenshot change type check)
 */
export const hasUIChanges = {
  change_type: "code",
  has_ui_changes: "yes",
};

/**
 * No UI changes (skip screenshots)
 */
export const noUIChanges = {
  change_type: "code",
  has_ui_changes: "no",
};

/**
 * Standard development plan
 * NOTE: plan_summary is string (min 50 chars)
 */
export const standardPlan = {
  plan_summary:
    "Three-step development plan for implementing user authentication with login endpoint and comprehensive testing",
  development_plan_file: "./moira-ws/user-auth-20251225-1200/development-plan.md",
  total_steps: 3,
};

/**
 * Plan approved by agent review (no issues)
 */
export const planReviewNoIssues = {
  review_issues_count: 0,
};

/**
 * Plan with issues from agent review
 */
export const planReviewWithIssues = {
  review_issues_count: 2,
};

/**
 * Plan approved by user
 * NOTE: plan_approval must be "yes" or "no"
 */
export const planApproved = {
  plan_approval: "yes",
};

/**
 * Plan rejected by user
 * NOTE: plan_approval must be "yes" or "no"
 */
export const planRejected = {
  plan_approval: "no",
};

/**
 * Standard plan tracking initialization
 */
export const standardPlanTracking = {
  current_step_name: "Setup auth module",
  total_steps: 3,
};

/**
 * Single step plan tracking
 */
export const singleStepPlanTracking = {
  current_step_name: "Implementation",
  total_steps: 1,
};

/**
 * Standard next step name (for multi-step plans)
 */
export const nextStepName = {
  current_step_name: "Next step",
};

/**
 * Standard step implementation
 */
export const standardImplementation = {
  implemented_functionality: "Created auth module with login/logout endpoints",
};

/** Read prior iteration results (new in v8.7.0 - reached when current_iteration > 1) */
export const priorIterationResultsRead = {
  prior_results_loaded: true,
};

/** Read prior report (new in v8.7.0 - reached when validation_attempt_count > 1) */
export const priorReportRead = {
  prior_report_read: true,
};

/**
 * Standard initial iteration workspace (created BEFORE implementation)
 * NOTE: iteration_directory pattern: ./moira-ws/{feature}-{date}/step-{N}/iteration-{M}/
 */
export const standardInitialIterationWorkspace = {};

/**
 * Standard iteration workspace (created in fix cycles with step-results snapshot)
 */
export const standardIterationWorkspace = {
  step_results_file: "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/step-results.md",
};

/**
 * Startup successful
 */
export const startupSuccess = {
  system_startup_ok: "yes",
};

/**
 * Startup failed
 */
export const startupFailed = {
  system_startup_ok: "no",
};

/**
 * Change type: code changes
 */
export const codeChanges = {
  change_type: "code",
  has_ui_changes: "no",
};

/**
 * Change type: code changes with UI impact
 */
export const codeChangesWithUI = {
  change_type: "code",
  has_ui_changes: "yes",
};

/**
 * Change type: documentation only
 * NOTE: must be "documentation_only" not "documentation"
 */
export const documentationOnlyChanges = {
  change_type: "documentation_only",
  has_ui_changes: "no",
};

/**
 * Change type: research only
 * NOTE: must be "research_only" not "research"
 */
export const researchOnlyChanges = {
  change_type: "research_only",
  has_ui_changes: "no",
};

/**
 * Change type: tests only
 * NOTE: must be "tests_only" not "tests"
 */
export const testsOnlyChanges = {
  change_type: "tests_only",
  has_ui_changes: "no",
};

/**
 * Code analysis with functions
 */
export const codeAnalysisWithFunctions = {
  functionality_list: ["login()", "logout()", "validateToken()"],
};

/**
 * All functions working
 */
export const allFunctionsWorking = {
  functions_working_count: 3,
};

/**
 * Some functions broken
 */
export const someFunctionsBroken = {
  functions_working_count: 1,
};

/**
 * All tests pass
 */
export const allTestsPass = {
  tests_passed_count: 42,
  tests_failed_count: 0,
};

/**
 * Some tests fail
 */
export const someTestsFail = {
  tests_passed_count: 40,
  tests_failed_count: 2,
};

/**
 * Test failure analysis - fix implementation
 * NOTE: fix_strategy must be "fix_implementation" or "update_tests"
 */
export const testFailureFixCode = {
  failure_analysis: "Auth token validation bug",
  fix_strategy: "fix_implementation",
};

/**
 * Test failure analysis - update tests
 * NOTE: fix_strategy must be "fix_implementation" or "update_tests"
 */
export const testFailureUpdateTests = {
  failure_analysis: "Tests outdated after API change",
  fix_strategy: "update_tests",
};

/**
 * Code quality check passed
 * NOTE: condition checks total_standards_met_count == 15 for pass
 */
export const qualityCheckPassed = {
  total_standards_met_count: 15,
};

/**
 * Code quality check failed
 * NOTE: anything less than 15 triggers fix flow
 */
export const qualityCheckFailed = {
  total_standards_met_count: 10,
};

/**
 * Implementation complete
 */
export const implementationComplete = {
  tasks_completed_fully: 3,
  total_tasks_planned: 3,
};

/**
 * Implementation incomplete
 */
export const implementationIncomplete = {
  tasks_completed_fully: 2,
  total_tasks_planned: 3,
};

/**
 * Browser impact - testing required
 */
export const browserTestingRequired = {
  expected_browser_functions: 3,
  browser_impact_reason: "UI changes require browser testing",
};

/**
 * Browser impact - no testing needed
 */
export const noBrowserTesting = {
  expected_browser_functions: 0,
  browser_impact_reason: "No browser changes",
};

/**
 * Browser validation passed
 */
export const browserValidationPassed = {
  working_browser_functions: 3,
};

/**
 * Browser validation failed
 */
export const browserValidationFailed = {
  working_browser_functions: 1,
  browser_issues: "Login button unresponsive, Form validation missing",
};

/**
 * Testing needs - new tests required
 */
export const newTestsRequired = {
  functions_requiring_tests: ["login()", "logout()"],
};

/**
 * Testing needs - no new tests
 */
export const noNewTestsRequired = {
  functions_requiring_tests: [],
};

/**
 * Documentation valid
 * NOTE: expected_doc_issues is 0 when documentation is valid
 */
export const documentationValid = {
  expected_doc_issues: 0,
  documentation_issues_summary: "No documentation issues found",
};

/**
 * Documentation invalid
 * NOTE: expected_doc_issues is number, documentation_issues_summary is string
 */
export const documentationInvalid = {
  expected_doc_issues: 2,
  documentation_issues_summary: "Missing API docs, Outdated examples",
};

/**
 * Step documentation updated
 */
export const stepDocumentationUpdated = {
  documentation_updated: "yes",
};

/**
 * Checklist passed
 */
export const checklistPassed = {
  checklist_completed_items: 5,
  checklist_total_items: 5,
};

/**
 * Checklist failed
 */
export const checklistFailed = {
  checklist_completed_items: 3,
  checklist_total_items: 5,
};

/**
 * Agent validation passed
 * NOTE: agent_issues_found must be "yes" or "no"
 */
export const agentValidationPassed = {
  agent_issues_found: "no",
  agent_review_file: "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/gate-review.md",
};

/**
 * Agent validation failed - no plan update
 * NOTE: agent_issues_found must be "yes" or "no"
 */
export const agentValidationFailedNoPlanUpdate = {
  agent_issues_found: "yes",
  agent_review_file: "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/gate-review.md",
};

/**
 * Agent validation failed - needs plan update
 * NOTE: agent_issues_found must be "yes" or "no"
 */
export const agentValidationFailedWithPlanUpdate = {
  agent_issues_found: "yes",
  agent_review_file: "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/gate-review.md",
};

/**
 * Fix agent feedback - no plan update
 * NOTE: action_taken must be "fixes_applied" or "plan_needs_update"
 */
export const fixAgentFeedbackNoPlanUpdate = {
  action_taken: "fixes_applied",
  fixes_description: "Added error handling",
  plan_issues_description: "",
};

/**
 * Fix agent feedback - with plan update
 * NOTE: action_taken must be "fixes_applied" or "plan_needs_update"
 */
export const fixAgentFeedbackWithPlanUpdate = {
  action_taken: "plan_needs_update",
  fixes_description: "Restructured auth module",
  plan_issues_description: "Need to add step 4 for OAuth integration",
};

/**
 * Commit step
 */
export const commitStep = {
  commit_hash: "abc123def",
};

/**
 * User approval needed
 */
export const userApprovalNeeded = {
  user_approval_needed: "yes",
  approval_reason: "Breaking API change",
};

/**
 * User approval not needed
 */
export const userApprovalNotNeeded = {
  user_approval_needed: "no",
  approval_reason: "",
};

/**
 * User step approved
 * NOTE: user_step_approval must be "approved" or "needs_fixes"
 */
export const userStepApproved = {
  user_step_approval: "approved",
  user_step_feedback: "Looks good",
};

/**
 * User step rejected - no plan update
 * NOTE: user_step_approval must be "approved" or "needs_fixes"
 */
export const userStepRejectedNoPlanUpdate = {
  user_step_approval: "needs_fixes",
  user_step_feedback: "Need better error messages",
};

/**
 * User step rejected - with plan update
 * NOTE: user_step_approval must be "approved" or "needs_fixes"
 */
export const userStepRejectedWithPlanUpdate = {
  user_step_approval: "needs_fixes",
  user_step_feedback: "Actually need OAuth instead",
};

/**
 * Record feedback to requirements - no major plan update
 * For record-feedback-to-requirements node
 */
export const recordFeedbackNoPlanUpdate = {
  requirements_updated: true,
  plan_needs_major_update: false,
};

/**
 * Record feedback to requirements - with plan update
 * For record-feedback-to-requirements node
 */
export const recordFeedbackWithPlanUpdate = {
  requirements_updated: true,
  plan_needs_major_update: true,
};

/**
 * Plan complete
 */
export const planComplete = {
  // This is determined by expression node comparing current_step_index > total_steps
};

/**
 * Requirements coverage validation - all requirements covered (zero gaps)
 */
export const requirementsCoverageValid = {
  requirements_gaps_count: 0,
  total_requirements: 5,
};

/**
 * Requirements coverage validation - gaps found
 */
export const requirementsCoverageWithGaps = {
  requirements_gaps_count: 2,
  total_requirements: 5,
};

/**
 * Final report generated (first attempt)
 */
export const finalReportGenerated = {
  final_report_file: "./moira-ws/user-auth-20251225-1200/final-report-v1.md",
};

/**
 * Final report generated (second attempt, after rejection)
 */
export const finalReportGeneratedV2 = {
  final_report_file: "./moira-ws/user-auth-20251225-1200/final-report-v2.md",
};

/**
 * User confirms results reviewed (present-results node)
 * NOTE: present-results has empty inputSchema (properties: {}, required: [])
 * after change D2 removed user_satisfied field. Must send empty object.
 */
export const userPermissionGranted = {};

/**
 * User satisfied
 */
export const userSatisfied = {
  user_satisfaction: "satisfied",
  user_feedback: "Great work!",
};

/**
 * User not satisfied
 * NOTE: user_satisfaction must be "satisfied" or "needs_work"
 */
export const userNotSatisfied = {
  user_satisfaction: "needs_work",
  user_feedback: "Need additional features",
};

/**
 * User feedback recorded to requirements (Path D)
 */
export const userFeedbackRecorded = {
  requirements_updated: true,
};

/**
 * Additional steps created
 * NOTE: additional_steps_created is array of strings (min 30 chars each)
 */
export const additionalStepsCreated = {
  additional_steps_created: [
    "Step 4: Implement OAuth integration with Google and GitHub providers",
    "Step 5: Add two-factor authentication using TOTP or SMS verification",
  ],
  plan_changes_summary: "Added OAuth and 2FA steps",
};

/**
 * Extension approved
 * NOTE: extension_approval must be "yes" or "no"
 */
export const extensionApproved = {
  extension_approval: "yes",
  extension_feedback: "Good additions",
};

/**
 * Extension rejected
 * NOTE: extension_approval must be "yes" or "no"
 */
export const extensionRejected = {
  extension_approval: "no",
  extension_feedback: "Need more detail on the steps",
};

/**
 * Final documentation update
 */
export const finalDocumentationUpdate = {
  workflow_completion_summary:
    "User auth feature complete with login, logout, and session management",
};

/**
 * Express mode implementation
 * NOTE: basic_validation_passed must be boolean
 */
export const expressImplementation = {
  express_summary: "Fixed typo in README line 42",
  basic_validation_passed: true,
};

/**
 * Express validation failed
 * NOTE: basic_validation_passed must be boolean
 */
export const expressValidationFailed = {
  express_summary: "Attempted fix but found deeper issue",
  basic_validation_passed: false,
};

/**
 * Express failure - retry
 * NOTE: fix_strategy must be "fix_implementation" or "update_tests"
 */
export const expressFailureRetry = {
  failure_analysis: "Simple fix, will retry",
  fix_strategy: "fix_implementation",
};

/**
 * Express failure - switch to full
 * NOTE: fix_strategy must be "fix_implementation" or "update_tests"
 */
export const expressFailureSwitch = {
  failure_analysis: "Task more complex than expected",
  fix_strategy: "update_tests",
};

/**
 * Initial system startup - success
 * NOTE: system_status must be "yes", "no", or "environmental_issue"
 */
export const initialSystemStartup = {
  system_status: "yes",
};

/**
 * Initial system startup - has fixable problems
 */
export const initialSystemStartupFailed = {
  system_status: "no",
};

/**
 * Initial system startup - environmental issue (needs user intervention)
 */
export const initialSystemStartupEnvironmental = {
  system_status: "environmental_issue",
};

/**
 * Environmental issue fixed by user
 */
export const environmentalIssueFixed = {
  user_confirmation: "fixed",
};

/**
 * Initial tests run
 */
export const initialTestsRun = {};

/**
 * Plan refinement
 * NOTE: development_plan is array of strings (min 20 chars each)
 *       plan_summary is string (min 50 chars)
 */
export const planRefinement = {
  refinement_summary: "Added input validation to step 2",
  plan_summary:
    "Three-step refined development plan with enhanced validation and comprehensive testing coverage",
  plan_file_updated: "yes",
};

/**
 * Refinement approved
 * NOTE: refinement_approval must be "yes" or "no"
 */
export const refinementApproved = {
  refinement_approval: "yes",
  refinement_feedback: "Good refinements",
};

/**
 * Refinement rejected
 * NOTE: refinement_approval must be "yes" or "no"
 */
export const refinementRejected = {
  refinement_approval: "no",
  refinement_feedback: "Still need more detail",
};

/**
 * Refinement review passed
 */
export const refinementReviewPassed = {
  refinement_review_issues_count: 0,
  refinement_issues_found: [],
};

/**
 * Refinement review failed
 * NOTE: refinement_issues_found is array of objects
 */
export const refinementReviewFailed = {
  refinement_review_issues_count: 1,
  refinement_issues_found: [
    {
      issue: "Step 2 still lacks detail",
      affected_step: "Step 2",
      suggested_fix: "Add more implementation details",
    },
  ],
};

/**
 * Extension review passed
 * NOTE: extension_issues_found is array of objects
 */
export const extensionReviewPassed = {
  extension_review_issues_count: 0,
  extension_issues_found: [],
};

/**
 * Extension review failed
 * NOTE: extension_issues_found is array of objects
 */
export const extensionReviewFailed = {
  extension_review_issues_count: 1,
  extension_issues_found: [
    {
      issue: "OAuth step needs API keys",
      affected_step: "Step 4",
      suggested_fix: "Add API key configuration",
    },
  ],
};

/**
 * Set extension total steps
 */
export const setExtensionTotalSteps = {
  total_steps: 5,
};

/**
 * Plan update during execution
 * NOTE: development_plan is array of strings (min 20 chars each)
 */
export const approveCurrentStepBeforeReplan = {
  step_approved_for_closure: true,
};

export const planUpdateDuringExecution = {
  plan_changes_description: "Added new requirement from user feedback",
};

/**
 * Plan update approved
 * NOTE: update_approval must be "yes" or "no"
 */
export const planUpdateApproved = {
  update_approval: "yes",
  update_feedback: "Good addition",
};

/**
 * Plan update rejected
 * NOTE: update_approval must be "yes" or "no"
 */
export const planUpdateRejected = {
  update_approval: "no",
  update_feedback: "Need better justification",
};

/**
 * Plan update review passed
 * NOTE: update_issues_found is array of objects
 */
export const planUpdateReviewPassed = {
  update_review_issues_count: 0,
  update_issues_found: [],
};

/**
 * Plan update review failed
 * NOTE: update_issues_found is array of objects
 */
export const planUpdateReviewFailed = {
  update_review_issues_count: 1,
  update_issues_found: [
    {
      issue: "New step conflicts with step 2",
      affected_step: "Step 3",
      suggested_fix: "Reorder steps",
    },
  ],
};

/**
 * Set update total steps
 */
export const setUpdateTotalSteps = {
  total_steps: 3,
};

/**
 * Reinitialize plan tracking
 */
export const reinitializePlanTracking = {
  tracking_reinitialized: "yes",
  current_step_name: "Setup",
  total_steps: 3,
};

// === Fix action results ===
// NOTE: problems_fixed must be "yes" for all fix actions

export const startupFixed = {
  problems_fixed: "yes",
};

export const startupFixDocumented = {};

export const testsFixedByCode = {
  code_fixed: "yes",
};

export const testFixesDocumented = {
  test_fixes_file: "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/test-fixes.md",
};

export const testsUpdated = {
  test_updates: "Updated 3 test files",
  test_updates_file: "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/test-updates.md",
};

export const incompleteFixed = {
  tasks_completed: "yes",
};

export const completionFixesDocumented = {
  completion_fixes_file:
    "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/completion-fixes.md",
};

export const functionalityFixed = {
  functionality_fixed: "yes",
};

export const functionalityFixesDocumented = {
  functionality_fixes_file:
    "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/functionality-fixes.md",
};

export const qualityFixed = {
  problems_fixed: "yes",
};

export const qualityFixesDocumented = {
  quality_architecture_fixes_file:
    "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/quality-architecture-fixes.md",
};

export const checklistFixed = {
  checklist_issues_fixed: "yes",
};

export const newTestsWritten = {
  tests_created: "yes",
};

export const newTestsDocumented = {
  new_tests_file: "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/new-tests.md",
};

export const documentationFixed = {
  fixed_doc_issues: 2,
  documentation_fixes: "Updated API documentation",
};

export const documentationFixesDocumented = {
  documentation_fixes_file:
    "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/documentation-fixes.md",
};

export const checklistFixesDocumented = {
  checklist_fixes_file: "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/checklist-fixes.md",
};

export const reviewFixesDocumented = {
  review_fixes_file: "./moira-ws/user-auth-20251225-1200/step-1/iteration-1/review-fixes.md",
};

/**
 * Update current step plan after user feedback (no major plan update path)
 * For update-current-step-plan node
 */
export const updateCurrentStepPlan = {
  plan_step_updated: true,
  step_changes_summary: "Updated step plan based on user feedback",
};

export const fixRefinedPlanIssues = {
  // Just continue flow
};

export const fixExtensionPlanIssues = {
  // Just continue flow
};

export const fixUpdatedPlanIssues = {
  // Just continue flow
};

// === Iteration limit escalation ===

/**
 * Escalation decision - continue fixing
 * NOTE: decision must be "continue" or "abort"
 */
export const escalationContinue = {
  escalation_decision: "continue",
};

/**
 * Escalation decision - abort development
 * NOTE: escalation_decision must be "continue" or "abort"
 */
export const escalationAbort = {
  escalation_decision: "abort",
};

/**
 * Document abort state
 */
export const abortStateDocumented = {
  abort_summary_file: "./moira-ws/user-auth-20251225-1200/step-1/abort-summary.md",
};

// === Teleport replan ===

/**
 * Teleport replan assessment
 */
export const teleportReplanAssessment = {
  replan_reason: "Current approach is fundamentally wrong, need different architecture",
};

// === Later-flow node inputs ===

/** Prior iteration results loaded */
export const readPriorIterationResults = {
  prior_results_loaded: true,
};

/** Prior report read */
export const readPriorReport = {
  prior_report_read: true,
};

/** Record feedback - no major plan update needed */
export const recordFeedbackToRequirements = {
  requirements_updated: true,
  plan_needs_major_update: false,
};

/** Record feedback - major plan update required */
export const recordFeedbackRequiresPlanUpdate = {
  requirements_updated: true,
  plan_needs_major_update: true,
};

/** User review with screenshots - approved */
export const userReviewWithScreenshotsApproved = {
  user_step_approval: "approved",
  user_step_feedback: "",
};

/** User review with screenshots - rejected */
export const userReviewWithScreenshotsRejected = {
  user_step_approval: "needs_fixes",
  user_step_feedback: "Need to fix styling",
};
