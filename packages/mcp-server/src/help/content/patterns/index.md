---
title: Workflow Patterns
description: Reusable patterns for building workflows
---

Workflow patterns are reusable solutions to common workflow design problems.

## Available Patterns

| Pattern                                                          | Use Case                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [Minimal Graph](/docs/patterns/minimal-graph/)                   | Decide what earns a branch, a loop, or a separate agent turn            |
| [Information Collection](/docs/patterns/information-collection/) | Gather agent capabilities or user preferences at workflow start         |
| [Skip Pattern](/docs/patterns/skip/)                             | Allow users to skip optional steps                                      |
| [Validation Loop](/docs/patterns/validation-loop/)               | Verify results and retry on failure                                     |
| [Repair Reach](/docs/patterns/repair-reach/)                     | Route a repair by where the correction actually landed                  |
| [Branching](/docs/patterns/branching/)                           | Different paths for different scenarios                                 |
| [Dynamic Files](/docs/patterns/dynamic-files/)                   | Template-based file paths for reusability                               |
| [Step Verification](/docs/patterns/step-verification/)           | Verify step completion before proceeding                                |
| [Escalation](/docs/patterns/escalation/)                         | Handle failures with user intervention                                  |
| [Subagent Review](/docs/patterns/subagent-review/)               | Delegate reviews to independent subagents                               |
| [Completeness Self-Review](/docs/patterns/self-review/)          | Check every requirement against the real artifact before delivery       |
| [Process Revision](/docs/patterns/process-revision/)             | Change a plan, checklist, or corpus from inside a running workflow      |
| [Replan Pattern](/docs/patterns/replan/)                         | Revise a multi-step plan after execution has started                    |
| [Operating Mode](/docs/patterns/operating-mode/)                 | Run unattended without losing reviews or authority gates                |
| [Workspace](/docs/patterns/workspace/)                           | Organize workflow files in a dedicated workspace directory              |
| [Notes Persistence](/docs/patterns/notes-persistence/)           | Store and retrieve data across steps and executions                     |
| [Artifacts Publishing](/docs/patterns/artifacts-publishing/)     | Publish HTML content with shareable public URLs                         |
| [Static Configuration](/docs/patterns/static-configuration/)     | Store curated instructions as variableRegistry defaults for consistency |
| [Anti-Patterns](/docs/patterns/anti-patterns/)                   | Common workflow design mistakes to avoid                                |

## Pattern Selection Guide

**Unsure how many nodes the graph needs?** → [Minimal Graph](/docs/patterns/minimal-graph/)

**Need to collect configuration?** → [Information Collection](/docs/patterns/information-collection/)

**Need optional steps?** → [Skip Pattern](/docs/patterns/skip/)

**Need quality control?** → [Validation Loop](/docs/patterns/validation-loop/)

**A small fix keeps paying for the whole validation chain?** → [Repair Reach](/docs/patterns/repair-reach/)

**Need different paths?** → [Branching](/docs/patterns/branching/)

**Need reusable file references?** → [Dynamic Files](/docs/patterns/dynamic-files/)

**Need to verify completion?** → [Step Verification](/docs/patterns/step-verification/)

**Need failure handling?** → [Escalation](/docs/patterns/escalation/)

**Need independent verification?** → [Subagent Review](/docs/patterns/subagent-review/)

**Need to prove every requirement was met?** → [Completeness Self-Review](/docs/patterns/self-review/)

**Need to change the process while it runs?** → [Process Revision](/docs/patterns/process-revision/)

**Need to revise a plan mid-execution?** → [Replan Pattern](/docs/patterns/replan/)

**Need the workflow to run unattended?** → [Operating Mode](/docs/patterns/operating-mode/)

**Need organized working files?** → [Workspace](/docs/patterns/workspace/)

**Need data to survive across executions?** → [Notes Persistence](/docs/patterns/notes-persistence/)

**Need to publish a shareable page?** → [Artifacts Publishing](/docs/patterns/artifacts-publishing/)

**Need consistent agent instructions?** → [Static Configuration](/docs/patterns/static-configuration/)

**Need to avoid common mistakes?** → [Anti-Patterns](/docs/patterns/anti-patterns/)
