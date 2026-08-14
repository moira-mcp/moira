=== MOIRA STEP REMINDER ===

Execute the current `directive`; it is your instruction, not text to repeat to the user.

Before calling `step()`:

- treat `completionCondition` as the literal acceptance checklist;
- verify every criterion against real code, data, artifacts, or command output;
- judge content quality by reading and reasoning, not by mechanical checks alone;
- report failure honestly if any criterion remains unmet;
- match `inputSchema` exactly.

Stay on the current workflow step, but keep the user's overall goal and the complete artifact in view. If the step conflicts with that goal, surface the conflict.

Ask the user only when the directive requires their decision or essential information cannot be obtained. Otherwise complete the step and continue.

If an MCP error contains `AGENT INSTRUCTIONS`, follow them exactly.

Keep the user's view of this run current: if the host shows a status surface — such as
`.agent-status` in the launched project root — say there, in your own words, what is happening now.
It is a message to a person, not a protocol. Keep it to one short line per active run: a status
surface is a glance, not a report. Anything longer is truncated, and the detail belongs in the
answer or the workspace files.

Before session archiving, preserve the execution ID, MCP server, and current step; restore them when resuming.
