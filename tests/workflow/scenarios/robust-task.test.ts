/**
 * robust-task Scenario Tests
 *
 * Universal workflow for executing multi-step tasks with completion guarantee.
 * Supports two modes: with files (plan saved to disk) and without files (in-memory).
 * Structure: ONBOARD → UNDERSTAND → DECOMPOSE → VALIDATE → EXECUTE → VERIFY → DELIVER
 *
 * Coverage target: 100% nodes (55), 100% branches
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

/**
 * Load actual production workflow
 */
function loadProductionWorkflow(): WorkflowGraph {
  return findSystemCatalogEntry("robust-task", "public")!.graph as WorkflowGraph;
}

describe("robust-task Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "robust-task"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected validation loops (cycles are intentional)", () => {
      const cycles = detectCycles(workflow);
      // This workflow has intentional loops:
      // - fix-plan-issues → expr-inc-validation-round → ... → expr-reset-after-revision → validate-plan
      // - revise-plan → expr-reset-after-revision → validate-plan → present-plan
      // - fix-gaps → verify-criteria loop
      // - retry-step-feedback → execute-current-step loop
      // - complete-step → check-all-steps-done → execute-current-step loop
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(55);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        // === WITH FILES MODE ===

        // Scenario 1: Happy path with files - all steps succeed
        {
          name: "Happy path with files",
          description: "Complete task execution with file access, all steps pass first time",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "yes",
            },
            "understand-task": {
              task_description: "Implement user authentication module for the application",
              task_short_name: "auth-module",
              expected_deliverable: "Working authentication with login/logout",
              constraints: ["Must use JWT", "2 day deadline"],
              success_criteria: ["Users can log in", "Users can log out", "Sessions persist"],
              user_response_text: "I need to implement user authentication with JWT tokens",
            },
            "suggest-task-name": {
              task_name: "auth-module-impl",
            },
            "setup-workspace": {
              workspace_path: "./moira-ws/auth-module-impl-20251225-1000/",
              process_id_saved: "yes",
              requirements_saved: "yes",
            },
            "decompose-into-steps": {
              steps: [
                {
                  id: 1,
                  action: "Create user model",
                  expected_output: "User model with email/password",
                },
                {
                  id: 2,
                  action: "Implement login endpoint",
                  expected_output: "POST /auth/login working",
                },
                {
                  id: 3,
                  action: "Implement logout endpoint",
                  expected_output: "POST /auth/logout working",
                },
              ],
              total_steps: 3,
              current_step_action: "Create user model",
              current_step_expected_output: "User model with email/password",
              plan_saved_to_file: "yes",
            },
            "validate-plan": {
              issues_count: 0,
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "yes",
            },
            // Step execution loop - 3 steps
            "execute-current-step": [
              { step_completed: "yes", evidence: "Created src/models/user.ts with User class" },
              { step_completed: "yes", evidence: "Created POST /auth/login endpoint with JWT" },
              { step_completed: "yes", evidence: "Created POST /auth/logout endpoint" },
            ],
            "verify-step-execution": [
              {
                step_verified: "yes",
                verification_details: "User model exists with required fields",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Login endpoint returns JWT token",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Logout endpoint invalidates session",
                issues_found: [],
              },
            ],
            "complete-step": [
              {
                step_result_saved: "yes",
                execution_note: "auth-module. Step 2/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "auth-module. Step 3/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "auth-module. Step 4/3",
              },
            ],
            "verify-criteria": {
              all_criteria_met: "yes",
              criteria_results: [
                { criterion: "Users can log in", met: true, evidence: "Login endpoint tested" },
                { criterion: "Users can log out", met: true, evidence: "Logout endpoint tested" },
                {
                  criterion: "Sessions persist",
                  met: true,
                  evidence: "JWT stored in localStorage",
                },
              ],
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "Complete authentication module with JWT-based login/logout",
              summary: "Implemented user model, login and logout endpoints with JWT",
              artifacts: ["src/models/user.ts", "src/routes/auth.ts"],
              recommendations: ["Add password reset", "Add OAuth support"],
            },
          },
        },

        // Scenario 2: Without files mode - quick task
        {
          name: "Happy path without files",
          description: "Complete task execution without file access (in-memory)",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Quick fix for the login button color",
              task_short_name: "login-btn-fix",
              expected_deliverable: "Login button with correct color",
              constraints: [],
              success_criteria: ["Button is blue"],
              user_response_text: "Fix the login button color to blue",
            },
            "decompose-into-steps": {
              steps: [
                { id: 1, action: "Find button CSS", expected_output: "Located button.login class" },
                {
                  id: 2,
                  action: "Change color to blue",
                  expected_output: "Color changed to #0066cc",
                },
                { id: 3, action: "Verify change", expected_output: "Button displays as blue" },
              ],
              total_steps: 3,
              current_step_action: "Find button CSS",
              current_step_expected_output: "Located button.login class",
              plan_saved_to_file: "no",
            },
            "validate-plan": {
              issues_count: 0,
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "ok",
            },
            "execute-current-step": [
              { step_completed: "yes", evidence: "Found in styles.css line 45" },
              { step_completed: "yes", evidence: "Changed background-color to #0066cc" },
              { step_completed: "yes", evidence: "Button now displays blue in browser" },
            ],
            "verify-step-execution": [
              {
                step_verified: "yes",
                verification_details: "CSS file and line confirmed",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Color value is correct",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Visual confirmation in browser",
                issues_found: [],
              },
            ],
            "complete-step": [
              {
                step_result_saved: "yes",
                execution_note: "login-btn-fix. Step 2/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "login-btn-fix. Step 3/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "login-btn-fix. Step 4/3",
              },
            ],
            "verify-criteria": {
              all_criteria_met: "yes",
              criteria_results: [
                {
                  criterion: "Button is blue",
                  met: true,
                  evidence: "Button background is #0066cc",
                },
              ],
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "Login button now displays with blue color",
              summary: "Changed CSS color property from red to blue",
              artifacts: ["styles.css"],
            },
          },
        },

        // Scenario 3: Plan validation fails and gets fixed
        {
          name: "Plan validation failure with fix",
          description: "Plan has issues, gets fixed, then proceeds",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "yes",
            },
            "understand-task": {
              task_description: "Add email notification feature",
              task_short_name: "email-notify",
              expected_deliverable: "Working email notifications",
              constraints: ["Use SendGrid"],
              success_criteria: ["Emails are sent", "Templates work"],
              user_response_text: "I need email notifications using SendGrid",
            },
            "suggest-task-name": {
              task_name: "email-notifications",
            },
            "setup-workspace": {
              workspace_path: "./moira-ws/email-notifications-20251225-1100/",
              process_id_saved: "yes",
              requirements_saved: "yes",
            },
            "decompose-into-steps": {
              steps: [
                { id: 1, action: "Configure SendGrid", expected_output: "API key configured" },
                { id: 2, action: "Create templates", expected_output: "Email templates ready" },
                { id: 3, action: "Implement send function", expected_output: "sendEmail() works" },
              ],
              total_steps: 3,
              current_step_action: "Configure SendGrid",
              current_step_expected_output: "API key configured",
              plan_saved_to_file: "yes",
            },
            // First validation fails, second passes
            "validate-plan": [
              {
                issues_count: 1,
                validation_issues: [
                  {
                    step_id: 1,
                    issue: "Missing specific file path for config",
                    suggestion: "Specify .env.local",
                  },
                ],
              },
              {
                issues_count: 0,
              },
            ],
            "fix-plan-issues": {
              steps: [
                {
                  id: 1,
                  action: "Add SENDGRID_API_KEY to .env.local",
                  expected_output: "API key in .env.local",
                },
                {
                  id: 2,
                  action: "Create templates in /emails/",
                  expected_output: "Email templates in /emails/",
                },
                {
                  id: 3,
                  action: "Implement sendEmail in /lib/email.ts",
                  expected_output: "sendEmail() exports",
                },
              ],
              total_steps: 3,
              fixes_applied: ["Added specific file paths to all steps"],
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "yes looks good",
            },
            "execute-current-step": [
              { step_completed: "yes", evidence: "Added SENDGRID_API_KEY=xxx to .env.local" },
              {
                step_completed: "yes",
                evidence: "Created welcome.html and reset.html in /emails/",
              },
              { step_completed: "yes", evidence: "Created sendEmail function in /lib/email.ts" },
            ],
            "verify-step-execution": [
              {
                step_verified: "yes",
                verification_details: "Environment variable exists",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Both template files exist",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Function exported correctly",
                issues_found: [],
              },
            ],
            "complete-step": [
              {
                step_result_saved: "yes",
                execution_note: "email-notify. Step 2/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "email-notify. Step 3/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "email-notify. Step 4/3",
              },
            ],
            "verify-criteria": {
              all_criteria_met: "yes",
              criteria_results: [
                { criterion: "Emails are sent", met: true, evidence: "Test email received" },
                { criterion: "Templates work", met: true, evidence: "Templates render correctly" },
              ],
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "Email notification system with SendGrid integration",
              summary: "Configured SendGrid, created templates, implemented send function",
              artifacts: [".env.local", "/emails/welcome.html", "/lib/email.ts"],
            },
          },
        },

        // Scenario 4: User rejects plan, revision loop
        {
          name: "Plan rejection with revision",
          description: "User rejects initial plan, plan is revised",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Add dark mode support",
              task_short_name: "dark-mode",
              expected_deliverable: "Working dark mode toggle",
              constraints: [],
              success_criteria: ["Toggle works", "Preference persists"],
              user_response_text: "Add dark mode to the app",
            },
            "decompose-into-steps": {
              steps: [
                { id: 1, action: "Add toggle button", expected_output: "Toggle visible" },
                { id: 2, action: "Add CSS variables", expected_output: "CSS variables defined" },
                { id: 3, action: "Add localStorage", expected_output: "Preference saved" },
              ],
              total_steps: 3,
              current_step_action: "Add toggle button",
              current_step_expected_output: "Toggle visible",
              plan_saved_to_file: "no",
            },
            "validate-plan": [{ issues_count: 0 }, { issues_count: 0 }],
            // First presentation rejected, second approved
            "present-plan": [
              {
                plan_approved: "no",
                revision_feedback: "Add system preference detection first",
                user_response_text: "No, first detect system preference",
              },
              {
                plan_approved: "yes",
                user_response_text: "yes now it's good",
              },
            ],
            "revise-plan": {
              steps: [
                {
                  id: 1,
                  action: "Detect system preference",
                  expected_output: "prefers-color-scheme detected",
                },
                { id: 2, action: "Add toggle button", expected_output: "Toggle visible" },
                { id: 3, action: "Add CSS variables", expected_output: "CSS variables defined" },
                { id: 4, action: "Add localStorage", expected_output: "Preference saved" },
              ],
              total_steps: 4,
            },
            "execute-current-step": [
              {
                step_completed: "yes",
                evidence: "Added matchMedia query for prefers-color-scheme",
              },
              { step_completed: "yes", evidence: "Added toggle button to header" },
              { step_completed: "yes", evidence: "Defined --bg-color, --text-color variables" },
              { step_completed: "yes", evidence: "Implemented localStorage.setItem/getItem" },
            ],
            "verify-step-execution": [
              {
                step_verified: "yes",
                verification_details: "matchMedia working",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Toggle renders in UI",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Variables toggle correctly",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Preference persists on reload",
                issues_found: [],
              },
            ],
            "complete-step": [
              {
                step_result_saved: "yes",
                execution_note: "dark-mode. Step 2/4",
              },
              {
                step_result_saved: "yes",
                execution_note: "dark-mode. Step 3/4",
              },
              {
                step_result_saved: "yes",
                execution_note: "dark-mode. Step 4/4",
              },
              {
                step_result_saved: "yes",
                execution_note: "dark-mode. Step 5/4",
              },
            ],
            "verify-criteria": {
              all_criteria_met: "yes",
              criteria_results: [
                { criterion: "Toggle works", met: true, evidence: "Toggle switches theme" },
                {
                  criterion: "Preference persists",
                  met: true,
                  evidence: "Reload keeps preference",
                },
              ],
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "Dark mode with system detection and persistence",
              summary: "Added system detection, toggle, CSS variables, localStorage",
              artifacts: ["theme.js", "styles.css"],
            },
          },
        },

        // Scenario 5: Step fails verification, retry succeeds
        {
          name: "Step retry after verification failure",
          description: "Step fails verification once, retry succeeds",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Fix broken API endpoint",
              task_short_name: "api-fix",
              expected_deliverable: "Working /api/users endpoint",
              constraints: [],
              success_criteria: ["Endpoint returns 200"],
              user_response_text: "Fix the /api/users endpoint that's returning 500",
            },
            "decompose-into-steps": {
              steps: [
                { id: 1, action: "Find error in logs", expected_output: "Error identified" },
                { id: 2, action: "Fix the bug", expected_output: "Bug fixed" },
                { id: 3, action: "Test endpoint", expected_output: "Returns 200" },
              ],
              total_steps: 3,
              current_step_action: "Find error in logs",
              current_step_expected_output: "Error identified",
              plan_saved_to_file: "no",
            },
            "validate-plan": {
              issues_count: 0,
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "yes",
            },
            // First two steps succeed
            "execute-current-step": [
              { step_completed: "yes", evidence: "Found NullPointerException in logs" },
              { step_completed: "yes", evidence: "Added null check before accessing user.email" },
              // Third step fails first time, succeeds second time
              { step_completed: "yes", evidence: "Endpoint tested but still failing" },
              { step_completed: "yes", evidence: "Fixed remaining issue, endpoint returns 200" },
            ],
            "verify-step-execution": [
              {
                step_verified: "yes",
                verification_details: "Error message captured",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Null check added in correct location",
                issues_found: [],
              },
              // Third step verification fails, then succeeds after retry
              {
                step_verified: "no",
                verification_details: "Still returning 500",
                issues_found: ["Another null check needed"],
              },
              {
                step_verified: "yes",
                verification_details: "Endpoint returns 200 OK",
                issues_found: [],
              },
            ],
            "complete-step": [
              {
                step_result_saved: "yes",
                execution_note: "api-fix. Step 2/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "api-fix. Step 3/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "api-fix. Step 4/3",
              },
            ],
            "retry-step-feedback": {
              retry_approach: "Check for all null values, not just user.email",
            },
            "verify-criteria": {
              all_criteria_met: "yes",
              criteria_results: [
                { criterion: "Endpoint returns 200", met: true, evidence: "curl returns 200 OK" },
              ],
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "Fixed /api/users endpoint",
              summary: "Added null checks to prevent NullPointerException",
              artifacts: ["users-controller.ts"],
            },
          },
        },

        // Scenario 6: Step escalation - user skips
        {
          name: "Step escalation with skip",
          description: "Step fails max retries, user chooses to skip",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Deploy to production server",
              task_short_name: "deploy-prod",
              expected_deliverable: "App deployed to production",
              constraints: [],
              success_criteria: ["App accessible on prod URL"],
              user_response_text: "Deploy the app to production",
            },
            "decompose-into-steps": {
              steps: [
                {
                  id: 1,
                  action: "Build production bundle",
                  expected_output: "dist/ folder created",
                },
                { id: 2, action: "Upload to server", expected_output: "Files on server" },
                { id: 3, action: "Restart service", expected_output: "Service running" },
              ],
              total_steps: 3,
              current_step_action: "Build production bundle",
              current_step_expected_output: "dist/ folder created",
              plan_saved_to_file: "no",
            },
            "validate-plan": {
              issues_count: 0,
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "yes",
            },
            // First step succeeds, second fails repeatedly
            "execute-current-step": [
              { step_completed: "yes", evidence: "npm run build completed, dist/ created" },
              { step_completed: "no", evidence: "SSH connection refused" },
              { step_completed: "no", evidence: "SSH still failing" },
              { step_completed: "no", evidence: "Cannot connect to server" },
              // After skip, third step runs
              { step_completed: "yes", evidence: "User handled upload, now restarting" },
            ],
            "verify-step-execution": [
              {
                step_verified: "yes",
                verification_details: "dist folder exists with files",
                issues_found: [],
              },
              {
                step_verified: "no",
                verification_details: "Upload failed - no SSH access",
                issues_found: ["SSH connection refused"],
              },
              {
                step_verified: "no",
                verification_details: "Still no SSH access",
                issues_found: ["SSH still failing"],
              },
              {
                step_verified: "no",
                verification_details: "Server unreachable",
                issues_found: ["Cannot connect to server"],
              },
              {
                step_verified: "yes",
                verification_details: "Service restarted successfully",
                issues_found: [],
              },
            ],
            "complete-step": [
              {
                step_result_saved: "yes",
                execution_note: "deploy-prod. Step 2/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "deploy-prod. Step 4/3",
              },
            ],
            "retry-step-feedback": [
              { retry_approach: "Try with different SSH key" },
              { retry_approach: "Try direct SCP instead of rsync" },
            ],
            "ask-user-skip-or-escalate": {
              user_decision: "skip",
              skip_reason: "Will upload manually via FTP",
              user_response_text: "skip, I'll upload via FTP",
            },
            "mark-step-skipped": {
              skipped_recorded: "yes",
              execution_note: "deploy-prod. Step 3/3",
            },
            "verify-criteria": {
              all_criteria_met: "yes",
              criteria_results: [
                {
                  criterion: "App accessible on prod URL",
                  met: true,
                  evidence: "https://prod.example.com returns 200",
                },
              ],
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "App deployed to production (step 2 done manually)",
              summary: "Built app, user uploaded via FTP, service restarted",
              artifacts: ["dist/", "production logs"],
            },
          },
        },

        // Scenario 7: Step escalation - user handles step
        {
          name: "Step escalation with user takeover",
          description: "Step fails max retries, user completes it",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Configure database backup",
              task_short_name: "db-backup",
              expected_deliverable: "Automated daily backups",
              constraints: [],
              success_criteria: ["Backup runs daily", "Backup can be restored"],
              user_response_text: "Set up automated database backups",
            },
            "decompose-into-steps": {
              steps: [
                { id: 1, action: "Create backup script", expected_output: "backup.sh created" },
                { id: 2, action: "Set up cron job", expected_output: "Cron configured" },
                { id: 3, action: "Test restore", expected_output: "Restore successful" },
              ],
              total_steps: 3,
              current_step_action: "Create backup script",
              current_step_expected_output: "backup.sh created",
              plan_saved_to_file: "no",
            },
            "validate-plan": {
              issues_count: 0,
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "yes",
            },
            // First step succeeds, second fails repeatedly
            "execute-current-step": [
              { step_completed: "yes", evidence: "Created backup.sh with pg_dump command" },
              { step_completed: "no", evidence: "No crontab access" },
              { step_completed: "no", evidence: "Still no access" },
              { step_completed: "no", evidence: "Permission denied" },
              // Third step after user handles second
              { step_completed: "yes", evidence: "Ran restore test successfully" },
            ],
            "verify-step-execution": [
              {
                step_verified: "yes",
                verification_details: "Script created and executable",
                issues_found: [],
              },
              {
                step_verified: "no",
                verification_details: "Cannot access crontab",
                issues_found: ["Permission denied"],
              },
              {
                step_verified: "no",
                verification_details: "Crontab permission denied",
                issues_found: ["Permission denied again"],
              },
              {
                step_verified: "no",
                verification_details: "Need sudo access",
                issues_found: ["Requires elevated permissions"],
              },
              {
                step_verified: "yes",
                verification_details: "Restore completed without errors",
                issues_found: [],
              },
            ],
            "complete-step": [
              {
                step_result_saved: "yes",
                execution_note: "db-backup. Step 2/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "db-backup. Step 3/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "db-backup. Step 4/3",
              },
            ],
            "retry-step-feedback": [
              { retry_approach: "Try with sudo" },
              { retry_approach: "Try using systemd timer instead" },
            ],
            "ask-user-skip-or-escalate": {
              user_decision: "escalate",
              user_response_text: "escalate, I'll add the cron job",
            },
            "user-handles-step": {
              user_completed: "yes",
              evidence: "Added cron job via sudo crontab -e",
              user_response_text: "Done, added 0 2 * * * /backup.sh",
            },
            "verify-criteria": {
              all_criteria_met: "yes",
              criteria_results: [
                { criterion: "Backup runs daily", met: true, evidence: "Cron scheduled for 2am" },
                { criterion: "Backup can be restored", met: true, evidence: "Restore test passed" },
              ],
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "Automated daily database backup system",
              summary: "Created backup script, user configured cron, restore tested",
              artifacts: ["backup.sh", "crontab entry"],
            },
          },
        },

        // Scenario 8: Step escalation - revise plan
        // Covers expr-restart-from-first (v4.4.1): revise-plan-from-escalation.success now
        // routes through this expression node (current_step=1, step_retry=0) → validate-plan,
        // restarting execution from the first step of the revised plan.
        {
          name: "Step escalation with plan revision",
          description: "Step fails, user chooses to revise plan",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Integrate payment gateway",
              task_short_name: "payment-gateway",
              expected_deliverable: "Working payment integration",
              constraints: [],
              success_criteria: ["Can process payments"],
              user_response_text: "Integrate Stripe for payments",
            },
            "decompose-into-steps": {
              steps: [
                { id: 1, action: "Install Stripe SDK", expected_output: "SDK installed" },
                { id: 2, action: "Configure webhook", expected_output: "Webhook receiving events" },
                { id: 3, action: "Test payment", expected_output: "Test payment processed" },
              ],
              total_steps: 3,
              current_step_action: "Install Stripe SDK",
              current_step_expected_output: "SDK installed",
              plan_saved_to_file: "no",
            },
            "validate-plan": [{ issues_count: 0 }, { issues_count: 0 }],
            "present-plan": [
              { plan_approved: "yes", user_response_text: "yes" },
              { plan_approved: "yes", user_response_text: "yes this is better" },
            ],
            // First step succeeds, second fails repeatedly
            "execute-current-step": [
              { step_completed: "yes", evidence: "npm install @stripe/stripe-js" },
              { step_completed: "no", evidence: "Webhook requires HTTPS" },
              { step_completed: "no", evidence: "Still failing without HTTPS" },
              { step_completed: "no", evidence: "Need to set up ngrok first" },
              // After plan revision, new steps
              { step_completed: "yes", evidence: "ngrok installed and running" },
              { step_completed: "yes", evidence: "Webhook configured with ngrok URL" },
              { step_completed: "yes", evidence: "Test payment of $1 successful" },
            ],
            "verify-step-execution": [
              {
                step_verified: "yes",
                verification_details: "Package in node_modules",
                issues_found: [],
              },
              {
                step_verified: "no",
                verification_details: "Stripe requires HTTPS endpoint",
                issues_found: ["HTTPS endpoint required"],
              },
              {
                step_verified: "no",
                verification_details: "HTTP rejected",
                issues_found: ["Stripe requires HTTPS"],
              },
              {
                step_verified: "no",
                verification_details: "Need tunnel solution",
                issues_found: ["Needs ngrok or similar"],
              },
              {
                step_verified: "yes",
                verification_details: "ngrok tunnel active",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Webhook events received",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Payment appears in dashboard",
                issues_found: [],
              },
            ],
            "complete-step": [
              {
                step_result_saved: "yes",
                execution_note: "payment-gateway. Step 2/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "payment-gateway. Step 2/4",
              },
              {
                step_result_saved: "yes",
                execution_note: "payment-gateway. Step 3/4",
              },
              {
                step_result_saved: "yes",
                execution_note: "payment-gateway. Step 4/4",
              },
              {
                step_result_saved: "yes",
                execution_note: "payment-gateway. Step 5/4",
              },
            ],
            "retry-step-feedback": [
              { retry_approach: "Try with self-signed certificate" },
              { retry_approach: "Check Stripe documentation for alternatives" },
            ],
            "ask-user-skip-or-escalate": {
              user_decision: "revise_plan",
              user_response_text: "revise_plan, we need to add ngrok step",
            },
            "revise-plan-from-escalation": {
              steps: [
                { id: 1, action: "Install Stripe SDK", expected_output: "SDK installed" },
                { id: 2, action: "Set up ngrok tunnel", expected_output: "HTTPS tunnel active" },
                { id: 3, action: "Configure webhook", expected_output: "Webhook receiving events" },
                { id: 4, action: "Test payment", expected_output: "Test payment processed" },
              ],
              total_steps: 4,
              revision_reason: "Need HTTPS tunnel before webhook setup",
            },
            "verify-criteria": {
              all_criteria_met: "yes",
              criteria_results: [
                {
                  criterion: "Can process payments",
                  met: true,
                  evidence: "Test payment succeeded",
                },
              ],
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "Stripe payment integration with webhook support",
              summary: "Installed SDK, set up ngrok, configured webhook, tested payment",
              artifacts: ["payment.ts", "webhook.ts", "ngrok config"],
            },
          },
        },

        // Scenario 9: Criteria verification fails, gaps fixed
        {
          name: "Criteria verification with gap fixing",
          description: "Some criteria not met initially, gaps fixed",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Create user registration form",
              task_short_name: "reg-form",
              expected_deliverable: "Working registration form",
              constraints: [],
              success_criteria: [
                "Form validates input",
                "Form submits data",
                "Error messages show",
              ],
              user_response_text: "Create user registration form with validation",
            },
            "decompose-into-steps": {
              steps: [
                { id: 1, action: "Create form HTML", expected_output: "Form rendered" },
                { id: 2, action: "Add validation", expected_output: "Validation working" },
                { id: 3, action: "Add submit handler", expected_output: "Data submits" },
              ],
              total_steps: 3,
              current_step_action: "Create form HTML",
              current_step_expected_output: "Form rendered",
              plan_saved_to_file: "no",
            },
            "validate-plan": {
              issues_count: 0,
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "yes",
            },
            "execute-current-step": [
              { step_completed: "yes", evidence: "Created registration.html with fields" },
              {
                step_completed: "yes",
                evidence: "Added required attribute and pattern validation",
              },
              { step_completed: "yes", evidence: "Added onSubmit handler with fetch" },
            ],
            "verify-step-execution": [
              {
                step_verified: "yes",
                verification_details: "Form renders in browser",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Validation prevents bad input",
                issues_found: [],
              },
              { step_verified: "yes", verification_details: "Data sent to API", issues_found: [] },
            ],
            "complete-step": [
              {
                step_result_saved: "yes",
                execution_note: "reg-form. Step 2/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "reg-form. Step 3/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "reg-form. Step 4/3",
              },
            ],
            // First criteria check fails, second passes
            "verify-criteria": [
              {
                all_criteria_met: "no",
                criteria_results: [
                  { criterion: "Form validates input", met: true, evidence: "Validation working" },
                  { criterion: "Form submits data", met: true, evidence: "Fetch submits data" },
                  { criterion: "Error messages show", met: false, evidence: "No error UI" },
                ],
                gaps: ["Error messages not displayed to user"],
              },
              {
                all_criteria_met: "yes",
                criteria_results: [
                  { criterion: "Form validates input", met: true, evidence: "Validation working" },
                  { criterion: "Form submits data", met: true, evidence: "Fetch submits data" },
                  {
                    criterion: "Error messages show",
                    met: true,
                    evidence: "Error div shows message",
                  },
                ],
              },
            ],
            "fix-gaps": {
              gaps_fixed: "yes",
              fix_evidence: [
                {
                  gap: "Error messages not displayed",
                  fix: "Added error div",
                  evidence: "Error shows in red below form",
                },
              ],
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "User registration form with validation and error display",
              summary: "Created form, added validation, submit handler, error messages",
              artifacts: ["registration.html", "validation.js"],
            },
          },
        },

        // Scenario 10: Step escalation - user resets retry counter
        {
          name: "Step escalation with retry reset",
          description: "Step fails max retries, user resets retry counter and step succeeds",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Set up CI/CD pipeline for the project",
              task_short_name: "ci-cd-setup",
              expected_deliverable: "Working CI/CD pipeline",
              constraints: [],
              success_criteria: ["Pipeline runs on push", "Tests run automatically"],
              user_response_text: "Set up CI/CD pipeline using GitHub Actions",
            },
            "decompose-into-steps": {
              steps: [
                {
                  id: 1,
                  action: "Create workflow YAML",
                  expected_output: ".github/workflows/ci.yml created",
                },
                {
                  id: 2,
                  action: "Configure test job",
                  expected_output: "Test job runs npm test",
                },
                {
                  id: 3,
                  action: "Configure deploy job",
                  expected_output: "Deploy triggers on main branch",
                },
              ],
              total_steps: 3,
              current_step_action: "Create workflow YAML",
              current_step_expected_output: ".github/workflows/ci.yml created",
              plan_saved_to_file: "no",
            },
            "validate-plan": {
              issues_count: 0,
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "yes",
            },
            // First step succeeds
            "execute-current-step": [
              { step_completed: "yes", evidence: "Created .github/workflows/ci.yml" },
              // Second step fails 3 times (max retries)
              { step_completed: "no", evidence: "GitHub API rate limited" },
              { step_completed: "no", evidence: "Still rate limited" },
              { step_completed: "no", evidence: "Rate limit persists" },
              // After reset, second step succeeds
              { step_completed: "yes", evidence: "Rate limit cleared, test job configured" },
              // Third step succeeds
              { step_completed: "yes", evidence: "Deploy job added with main branch trigger" },
            ],
            "verify-step-execution": [
              {
                step_verified: "yes",
                verification_details: "YAML file exists and is valid",
                issues_found: [],
              },
              {
                step_verified: "no",
                verification_details: "GitHub API returned 429",
                issues_found: ["Rate limited by GitHub API"],
              },
              {
                step_verified: "no",
                verification_details: "Still 429 from GitHub",
                issues_found: ["Rate limit not expired"],
              },
              {
                step_verified: "no",
                verification_details: "Rate limit ongoing",
                issues_found: ["Need to wait for rate limit reset"],
              },
              {
                step_verified: "yes",
                verification_details: "Test job correctly configured",
                issues_found: [],
              },
              {
                step_verified: "yes",
                verification_details: "Deploy job triggers on main branch push",
                issues_found: [],
              },
            ],
            "complete-step": [
              {
                step_result_saved: "yes",
                execution_note: "ci-cd-setup. Step 2/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "ci-cd-setup. Step 3/3",
              },
              {
                step_result_saved: "yes",
                execution_note: "ci-cd-setup. Step 4/3",
              },
            ],
            "retry-step-feedback": [
              { retry_approach: "Wait and retry GitHub API call" },
              { retry_approach: "Try using a different token" },
            ],
            "ask-user-skip-or-escalate": {
              user_decision: "reset",
              user_response_text: "reset, the rate limit should be cleared now",
            },
            "verify-criteria": {
              all_criteria_met: "yes",
              criteria_results: [
                {
                  criterion: "Pipeline runs on push",
                  met: true,
                  evidence: "Workflow triggers on push event",
                },
                {
                  criterion: "Tests run automatically",
                  met: true,
                  evidence: "Test job runs npm test in CI",
                },
              ],
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "GitHub Actions CI/CD pipeline with test and deploy jobs",
              summary: "Created workflow YAML, configured test and deploy jobs",
              artifacts: [".github/workflows/ci.yml"],
            },
          },
        },

        // Scenario 11: Plan validation round limit reached, user resets, then proceeds
        {
          name: "Plan validation round limit with reset",
          description:
            "validate-plan returns issues 5 times until validation_round hits limit, user resets counter, then plan validates clean",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Refactor the legacy reporting module",
              task_short_name: "report-refactor",
              expected_deliverable: "Refactored reporting module",
              constraints: [],
              success_criteria: ["Reports still generate correctly"],
              user_response_text: "Refactor the legacy reporting module",
            },
            "decompose-into-steps": {
              steps: [
                {
                  id: 1,
                  action: "Refactor report generator",
                  expected_output: "Generator refactored",
                },
              ],
              total_steps: 1,
              current_step_action: "Refactor report generator",
              current_step_expected_output: "Generator refactored",
              plan_saved_to_file: "no",
            },
            // 5 validation rounds with issues (round 0→5), then clean after reset
            "validate-plan": [
              {
                issues_count: 1,
                validation_issues: [
                  { step_id: 1, issue: "Step too vague", suggestion: "Add file paths" },
                ],
              },
              {
                issues_count: 1,
                validation_issues: [
                  { step_id: 1, issue: "Still vague", suggestion: "Add more detail" },
                ],
              },
              {
                issues_count: 1,
                validation_issues: [
                  { step_id: 1, issue: "Missing expected output", suggestion: "Define output" },
                ],
              },
              {
                issues_count: 1,
                validation_issues: [
                  { step_id: 1, issue: "Dependency unclear", suggestion: "State dependency" },
                ],
              },
              {
                issues_count: 1,
                validation_issues: [
                  { step_id: 1, issue: "Not self-contained", suggestion: "Make atomic" },
                ],
              },
              { issues_count: 0 },
            ],
            "fix-plan-issues": {
              steps: [
                {
                  id: 1,
                  action: "Refactor report generator in /src/reports/generator.ts",
                  expected_output: "Generator refactored, tests pass",
                },
              ],
              total_steps: 1,
              fixes_applied: ["Added file paths and measurable output"],
            },
            "ask-user-validation-limit-reached": {
              decision: "reset",
              user_response_text: "reset, keep fixing the plan",
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "yes",
            },
            "execute-current-step": {
              step_completed: "yes",
              evidence: "Refactored generator.ts, all report tests pass",
            },
            "verify-step-execution": {
              step_verified: "yes",
              verification_details: "Generator refactored and tests green",
              issues_found: [],
            },
            "complete-step": {
              step_result_saved: "yes",
              execution_note: "report-refactor. Step 2/1",
            },
            "verify-criteria": {
              all_criteria_met: "yes",
              criteria_results: [
                {
                  criterion: "Reports still generate correctly",
                  met: true,
                  evidence: "All report tests pass",
                },
              ],
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "Refactored reporting module with passing tests",
              summary: "Refactored generator, verified reports still work",
              artifacts: ["/src/reports/generator.ts"],
            },
          },
        },

        // Scenario 12: Plan validation round limit reached, user continues (accepts plan as-is)
        {
          name: "Plan validation round limit with continue",
          description:
            "validate-plan returns issues 5 times until validation_round hits limit, user continues (accept as-is) → notify-plan-ready",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Tune the search ranking algorithm",
              task_short_name: "search-tune",
              expected_deliverable: "Tuned search ranking",
              constraints: [],
              success_criteria: ["Relevant results rank higher"],
              user_response_text: "Tune the search ranking algorithm",
            },
            "decompose-into-steps": {
              steps: [
                {
                  id: 1,
                  action: "Adjust ranking weights",
                  expected_output: "Weights adjusted",
                },
              ],
              total_steps: 1,
              current_step_action: "Adjust ranking weights",
              current_step_expected_output: "Weights adjusted",
              plan_saved_to_file: "no",
            },
            // 5 validation rounds with issues (round 0→5), then user continues
            "validate-plan": [
              {
                issues_count: 1,
                validation_issues: [{ step_id: 1, issue: "Vague weights", suggestion: "Specify" }],
              },
              {
                issues_count: 1,
                validation_issues: [{ step_id: 1, issue: "No metric", suggestion: "Add metric" }],
              },
              {
                issues_count: 1,
                validation_issues: [
                  { step_id: 1, issue: "No baseline", suggestion: "Add baseline" },
                ],
              },
              {
                issues_count: 1,
                validation_issues: [{ step_id: 1, issue: "No test set", suggestion: "Define set" }],
              },
              {
                issues_count: 1,
                validation_issues: [{ step_id: 1, issue: "Unclear output", suggestion: "Clarify" }],
              },
            ],
            "fix-plan-issues": {
              steps: [
                {
                  id: 1,
                  action: "Adjust ranking weights in /src/search/ranker.ts",
                  expected_output: "NDCG improves on eval set",
                },
              ],
              total_steps: 1,
              fixes_applied: ["Added metric and file path"],
            },
            "ask-user-validation-limit-reached": {
              decision: "continue",
              user_response_text: "continue, accept the plan as-is",
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "yes",
            },
            "execute-current-step": {
              step_completed: "yes",
              evidence: "Adjusted weights in ranker.ts, NDCG up 0.05",
            },
            "verify-step-execution": {
              step_verified: "yes",
              verification_details: "NDCG improvement confirmed on eval set",
              issues_found: [],
            },
            "complete-step": {
              step_result_saved: "yes",
              execution_note: "search-tune. Step 2/1",
            },
            "verify-criteria": {
              all_criteria_met: "yes",
              criteria_results: [
                {
                  criterion: "Relevant results rank higher",
                  met: true,
                  evidence: "NDCG improved on eval set",
                },
              ],
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "Tuned search ranking with improved NDCG",
              summary: "Adjusted ranking weights, verified relevance improvement",
              artifacts: ["/src/search/ranker.ts"],
            },
          },
        },

        // Scenario 13: Criteria round limit reached, user resets, then criteria met
        {
          name: "Criteria round limit with reset",
          description:
            "verify-criteria returns not-met 5 times until criteria_round hits limit, user resets counter, then criteria met → deliver",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Add input validation to the contact form",
              task_short_name: "contact-validate",
              expected_deliverable: "Validated contact form",
              constraints: [],
              success_criteria: ["All fields are validated"],
              user_response_text: "Add input validation to the contact form",
            },
            "decompose-into-steps": {
              steps: [
                {
                  id: 1,
                  action: "Add field validation",
                  expected_output: "Validation in place",
                },
              ],
              total_steps: 1,
              current_step_action: "Add field validation",
              current_step_expected_output: "Validation in place",
              plan_saved_to_file: "no",
            },
            "validate-plan": {
              issues_count: 0,
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "yes",
            },
            "execute-current-step": {
              step_completed: "yes",
              evidence: "Added validation to all contact form fields",
            },
            "verify-step-execution": {
              step_verified: "yes",
              verification_details: "Validation present on all fields",
              issues_found: [],
            },
            "complete-step": {
              step_result_saved: "yes",
              execution_note: "contact-validate. Step 2/1",
            },
            // 5 criteria rounds not met (criteria_round 0→5), then met after reset
            "verify-criteria": [
              {
                all_criteria_met: "no",
                criteria_results: [
                  {
                    criterion: "All fields are validated",
                    met: false,
                    evidence: "Email unchecked",
                  },
                ],
                gaps: ["Email field not validated"],
              },
              {
                all_criteria_met: "no",
                criteria_results: [
                  {
                    criterion: "All fields are validated",
                    met: false,
                    evidence: "Phone unchecked",
                  },
                ],
                gaps: ["Phone field not validated"],
              },
              {
                all_criteria_met: "no",
                criteria_results: [
                  { criterion: "All fields are validated", met: false, evidence: "Name unchecked" },
                ],
                gaps: ["Name field not validated"],
              },
              {
                all_criteria_met: "no",
                criteria_results: [
                  {
                    criterion: "All fields are validated",
                    met: false,
                    evidence: "Message unchecked",
                  },
                ],
                gaps: ["Message field not validated"],
              },
              {
                all_criteria_met: "no",
                criteria_results: [
                  {
                    criterion: "All fields are validated",
                    met: false,
                    evidence: "Subject unchecked",
                  },
                ],
                gaps: ["Subject field not validated"],
              },
              {
                all_criteria_met: "yes",
                criteria_results: [
                  {
                    criterion: "All fields are validated",
                    met: true,
                    evidence: "All fields validated and tested",
                  },
                ],
              },
            ],
            "fix-gaps": {
              gaps_fixed: "yes",
              fix_evidence: [
                {
                  gap: "Field not validated",
                  fix: "Added validator",
                  evidence: "Validator covers the field",
                },
              ],
            },
            "ask-user-criteria-limit-reached": {
              decision: "reset",
              user_response_text: "reset, keep closing the gaps",
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "Contact form with full field validation",
              summary: "Added validation to every contact form field",
              artifacts: ["/src/forms/contact.ts"],
            },
          },
        },

        // Scenario 14: Criteria round limit reached, user continues (accepts gaps)
        {
          name: "Criteria round limit with continue",
          description:
            "verify-criteria returns not-met 5 times until criteria_round hits limit, user continues (accept gaps) → deliver",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Improve accessibility of the dashboard",
              task_short_name: "a11y-dashboard",
              expected_deliverable: "More accessible dashboard",
              constraints: [],
              success_criteria: ["Dashboard passes a11y audit"],
              user_response_text: "Improve accessibility of the dashboard",
            },
            "decompose-into-steps": {
              steps: [
                {
                  id: 1,
                  action: "Add ARIA labels",
                  expected_output: "ARIA labels added",
                },
              ],
              total_steps: 1,
              current_step_action: "Add ARIA labels",
              current_step_expected_output: "ARIA labels added",
              plan_saved_to_file: "no",
            },
            "validate-plan": {
              issues_count: 0,
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "yes",
            },
            "execute-current-step": {
              step_completed: "yes",
              evidence: "Added ARIA labels to dashboard widgets",
            },
            "verify-step-execution": {
              step_verified: "yes",
              verification_details: "ARIA labels present on widgets",
              issues_found: [],
            },
            "complete-step": {
              step_result_saved: "yes",
              execution_note: "a11y-dashboard. Step 2/1",
            },
            // 5 criteria rounds not met (criteria_round 0→5), then user continues
            "verify-criteria": [
              {
                all_criteria_met: "no",
                criteria_results: [
                  {
                    criterion: "Dashboard passes a11y audit",
                    met: false,
                    evidence: "3 contrast errors",
                  },
                ],
                gaps: ["Contrast issues remain"],
              },
              {
                all_criteria_met: "no",
                criteria_results: [
                  {
                    criterion: "Dashboard passes a11y audit",
                    met: false,
                    evidence: "2 contrast errors",
                  },
                ],
                gaps: ["Contrast issues remain"],
              },
              {
                all_criteria_met: "no",
                criteria_results: [
                  {
                    criterion: "Dashboard passes a11y audit",
                    met: false,
                    evidence: "1 contrast error",
                  },
                ],
                gaps: ["Contrast issue remains"],
              },
              {
                all_criteria_met: "no",
                criteria_results: [
                  {
                    criterion: "Dashboard passes a11y audit",
                    met: false,
                    evidence: "Focus order off",
                  },
                ],
                gaps: ["Focus order needs fixing"],
              },
              {
                all_criteria_met: "no",
                criteria_results: [
                  {
                    criterion: "Dashboard passes a11y audit",
                    met: false,
                    evidence: "Alt text missing",
                  },
                ],
                gaps: ["Alt text missing on icons"],
              },
            ],
            "fix-gaps": {
              gaps_fixed: "yes",
              fix_evidence: [
                {
                  gap: "Accessibility gap",
                  fix: "Applied a11y fix",
                  evidence: "Audit error count reduced",
                },
              ],
            },
            "ask-user-criteria-limit-reached": {
              decision: "continue",
              user_response_text: "continue, deliver as-is",
            },
            "deliver-result": {
              deliverable: "Dashboard with improved accessibility (some audit items accepted)",
              summary: "Added ARIA labels and contrast fixes; remaining items accepted by user",
              artifacts: ["/src/dashboard/index.tsx"],
            },
          },
        },

        // Scenario 15: Teleport-replan jump resets counters and restarts decomposition
        // F1 fix regression: after a teleport replan (teleport-replan → expr-replan-advance →
        // validate-plan), a subsequent validation issue must NOT reset current_step to 1 — the
        // replan path advances rather than restarting from the first step.
        {
          name: "Teleport replan resets and restarts plan",
          description:
            "After the first plan presentation, teleport to teleport-replan → expr-replan-advance → validate-plan, then complete normally",
          expect: { status: "completed" },
          teleportAfter: {
            afterNode: "present-plan",
            visitNumber: 1,
            teleportTo: "teleport-replan",
          },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Migrate the config loader to the new schema",
              task_short_name: "config-migrate",
              expected_deliverable: "Config loader on new schema",
              constraints: [],
              success_criteria: ["Config loads with new schema"],
              user_response_text: "Migrate the config loader to the new schema",
            },
            "decompose-into-steps": {
              steps: [
                {
                  id: 1,
                  action: "Update config loader",
                  expected_output: "Loader uses new schema",
                },
              ],
              total_steps: 1,
              current_step_action: "Update config loader",
              current_step_expected_output: "Loader uses new schema",
              plan_saved_to_file: "no",
            },
            "validate-plan": {
              issues_count: 0,
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "yes",
            },
            "teleport-replan": {
              revision_reason: "New schema requirements emerged; the plan must be rebuilt",
              total_steps: 2,
            },
            "execute-current-step": {
              step_completed: "yes",
              evidence: "Updated config loader to new schema, tests pass",
            },
            "verify-step-execution": {
              step_verified: "yes",
              verification_details: "Loader uses new schema and tests pass",
              issues_found: [],
            },
            "complete-step": {
              step_result_saved: "yes",
              execution_note: "config-migrate. Step 3/2",
            },
            "verify-criteria": {
              all_criteria_met: "yes",
              criteria_results: [
                {
                  criterion: "Config loads with new schema",
                  met: true,
                  evidence: "Config loads without errors under new schema",
                },
              ],
            },
            "final-review": { final_issues_count: 0 },
            "deliver-result": {
              deliverable: "Config loader migrated to the new schema",
              summary: "Rebuilt the plan after replan, updated loader, verified config loads",
              artifacts: ["/src/config/loader.ts"],
            },
          },
        },

        // Scenario 16: Final independent review finds a gap, fix-gaps loop, second review clean
        {
          name: "Final review gap then clean",
          description:
            "verify-criteria passes, but the independent final-review returns issues>0 once → route-final-review false → fix-gaps loop → verify-criteria → final-review clean → deliver",
          expect: { status: "completed" },
          mockInputs: {
            "check-file-access": {
              has_file_access: "no",
            },
            "understand-task": {
              task_description: "Add a health check endpoint to the service",
              task_short_name: "health-check",
              expected_deliverable: "Working /health endpoint",
              constraints: [],
              success_criteria: ["GET /health returns 200"],
              user_response_text: "Add a /health endpoint that returns 200",
            },
            "decompose-into-steps": {
              steps: [
                {
                  id: 1,
                  action: "Add /health route",
                  expected_output: "Route returns 200",
                },
              ],
              total_steps: 1,
              current_step_action: "Add /health route",
              current_step_expected_output: "Route returns 200",
              plan_saved_to_file: "no",
            },
            "validate-plan": {
              issues_count: 0,
            },
            "present-plan": {
              plan_approved: "yes",
              user_response_text: "yes",
            },
            "execute-current-step": {
              step_completed: "yes",
              evidence: "Added GET /health route returning 200",
            },
            "verify-step-execution": {
              step_verified: "yes",
              verification_details: "/health returns 200 in local test",
              issues_found: [],
            },
            "complete-step": {
              step_result_saved: "yes",
              execution_note: "health-check. Step 2/1",
            },
            "verify-criteria": {
              all_criteria_met: "yes",
              criteria_results: [
                {
                  criterion: "GET /health returns 200",
                  met: true,
                  evidence: "curl /health returns 200 OK",
                },
              ],
              gaps: ["Independent review flagged: health check does not verify dependencies"],
            },
            // First independent review finds a gap, second review is clean
            "final-review": [{ final_issues_count: 1 }, { final_issues_count: 0 }],
            "fix-gaps": {
              gaps_fixed: "yes",
              fix_evidence: [
                {
                  gap: "Health endpoint missing dependency check",
                  fix: "Added DB ping to health check",
                  evidence: "/health now verifies DB connectivity",
                },
              ],
            },
            "deliver-result": {
              deliverable: "Health check endpoint with dependency verification",
              summary: "Added /health route and DB connectivity check after review",
              artifacts: ["/src/routes/health.ts"],
            },
          },
        },
      ];

      // Run all scenarios
      const results: ScenarioResult[] = [];
      for (const scenario of scenarios) {
        const result = await runScenario(workflow, scenario);
        results.push(result);
      }

      // Calculate coverage
      const coverage = calculateCoverage(workflow, results, {
        includeGapAnalysis: true,
      });

      // Log coverage report
      console.log(formatCoverageReport(coverage));

      // Check for failed scenarios
      const failedScenarios = results.filter((r) => !r.passed);
      if (failedScenarios.length > 0) {
        console.error("Failed scenarios:");
        for (const s of failedScenarios) {
          console.error(`  - ${s.scenario}: ${s.error || s.failedExpectations?.join(", ")}`);
        }
      }
      expect(failedScenarios).toHaveLength(0);

      // Verify 100% coverage
      expect(coverage.nodeCoverage).toBe(100);
      expect(coverage.branchCoverage).toBe(100);
    });
  });
});
