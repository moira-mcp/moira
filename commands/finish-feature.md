---
description: "Start feature completion workflow in Moira"
---

# Finish Feature Workflow

<finish-feature>
<description>Find and start feature completion workflow in Moira</description>

<workflow-stages>

<stage-1>
<name>Workflow Discovery</name>
<actions>
  <list-workflows>Use mcp__moira__list_workflows to get available workflows</list-workflows>
  <find-completion>Find feature completion/finish workflow</find-completion>
  <validate>Ensure workflow exists and is executable</validate>
</actions>
</stage-1>

<stage-2>
<name>Start Workflow</name>
<actions>
  <start-process>Use mcp__moira__start_workflow with found workflow ID</start-process>
  <get-process-id>Capture returned process ID</get-process-id>
  <report>Report process ID and initial step to user</report>
</actions>
</stage-2>

<stage-3>
<name>Begin Execution</name>
<actions>
  <execute-first-step>Execute first workflow step as instructed by Moira</execute-first-step>
  <follow-workflow>Continue following workflow instructions for feature completion</follow-workflow>
</actions>
</stage-3>

</workflow-stages>

<error-handling>
<no-workflow>If completion workflow not found: report error with available workflows</no-workflow>
<start-failed>If workflow start fails: report error and suggest checking Moira status</start-failed>
</error-handling>

<arguments>
<input>$ARGUMENTS - optional: feature name or additional parameters</input>
</arguments>

</finish-feature>
