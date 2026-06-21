---
description: "Resume workflow execution from current branch context"
---

# Resume Workflow Execution

<resume-workflow>
<description>Find workflow process ID in moira-ws directory, restore context and assess readiness to continue</description>

<workflow-stages>

<stage-1>
<name>Process ID Discovery</name>
<actions>
  <find-workspace>Search for process-id.txt in ./moira-ws/*/process-id.txt</find-workspace>
  <multiple-workspaces>If multiple found: list them and ask user which to resume</multiple-workspaces>
  <read-process-id>Read process ID from found file</read-process-id>
  <validate-id>Ensure process ID exists and is valid UUID format</validate-id>
</actions>
<workspace-format>./moira-ws/{feature_name}-{YYYYMMDD}-{HHMM}/process-id.txt</workspace-format>
</stage-1>

<stage-2>
<name>Workflow State Restoration</name>
<actions>
  <get-current-step>Use mcp__moira__session (action: "current_step", executionId: process-id) to get current workflow state</get-current-step>
  <analyze-context>Analyze returned step information and execution context</analyze-context>
  <present-status>Present current workflow position and pending tasks to user</present-status>
</actions>
</stage-2>

<stage-3>
<name>Assess Completion and Continue</name>
<actions>
  <evaluate-progress>Determine how much of the current step has been completed</evaluate-progress>
  <check-completion-condition>Verify if completionCondition from current step is fully satisfied</check-completion-condition>
  <decision>
    <if-complete>If completionCondition is 100% met: proceed with mcp__moira__step to advance workflow</if-complete>
    <if-incomplete>If completionCondition NOT fully met: complete remaining work first, then proceed</if-incomplete>
    <if-unclear>If unclear whether condition is met: ask user for clarification before proceeding</if-unclear>
  </decision>
</actions>
<critical-rule>NEVER call mcp__moira__step until completionCondition is fully satisfied. Partial completion is not acceptable.</critical-rule>
</stage-3>

</workflow-stages>

<error-handling>
<no-workspace>If ./moira-ws/ not found or empty: report error, suggest starting new workflow with /start-development</no-workspace>
<no-process-id>If process-id.txt missing: report error and suggest manual process ID input via $ARGUMENTS</no-process-id>
<invalid-process>If Moira returns error for process ID: report and suggest restarting workflow</invalid-process>
</error-handling>

<arguments>
<input>$ARGUMENTS - optional: explicit process ID to bypass auto-detection</input>
<usage>Use when process-id.txt is missing but you know the execution ID</usage>
<example>/resume-workflow abc123-def456-...</example>
</arguments>

</resume-workflow>
