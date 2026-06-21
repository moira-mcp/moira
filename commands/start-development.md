---
description: "Start development workflow process in Moira"
---

# Start Development Workflow

<start-development>
<description>Find and start development workflow v7 in Moira</description>

<workflow-stages>

<stage-0>
<name>Branch Freshness Check</name>
<description>Ensure the current branch is up to date relative to master</description>
<actions>
  <check-context>Analyze the context:
    - Which branch we are on now (git branch --show-current)
    - Whether there are uncommitted changes (git status --short)
  </check-context>

<intelligent-decision>Decide whether an update is needed: - If we are ON master → skip this stage (no need to rebase onto itself) - If on a feature/dev branch → check freshness relative to master
</intelligent-decision>

<check-freshness>Check the branch is up to date: 1. Run `git fetch origin` to get fresh data 2. Update the local master: `git -C <path-to-master-worktree> fetch origin master:master` 3. Compare the current branch with master 4. Check whether there are uncommitted changes
</check-freshness>

<decide-action>Based on the check, decide: - If the branch is fresh → proceed to stage-1 - If master has new changes → suggest the user run `/rebase-master` - If there are uncommitted changes → ask what to do (commit/stash/continue)
</decide-action>
</actions>
<critical>
<skip-if-on-master>Do not rebase if already on master</skip-if-on-master>
</critical>
</stage-0>

<stage-1>
<name>Workflow Discovery</name>
<actions>
  <list-workflows>Use mcp__moira__list to get available workflows</list-workflows>
  <find-development>Find development workflow (v7 or latest version)</find-development>
  <validate>Ensure workflow exists and is executable</validate>
</actions>
</stage-1>

<stage-2>
<name>Start Workflow</name>
<actions>
  <start-process>Use mcp__moira__start with found workflow ID</start-process>
  <get-process-id>Capture returned process ID</get-process-id>
  <report>Report process ID and initial step to user</report>
</actions>
</stage-2>

<stage-3>
<name>Begin Execution</name>
<actions>
  <execute-first-step>Execute first workflow step as instructed by Moira</execute-first-step>
  <follow-workflow>Continue following workflow instructions</follow-workflow>
</actions>
</stage-3>

</workflow-stages>

<error-handling>
<no-workflow>If development workflow not found: report error with available workflows</no-workflow>
<start-failed>If workflow start fails: report error and suggest checking Moira status</start-failed>
</error-handling>

<arguments>
<input>$ARGUMENTS - optional: specific workflow version or additional parameters</input>
</arguments>

</start-development>
