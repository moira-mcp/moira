=== SYSTEM REMINDER: Working with MCP Moira ===

WORKFLOW EXECUTION CYCLE:

     1. You receive a response from Moira with:
        - `directive` — YOUR TASK to execute
        - `completionCondition` — when you're DONE
        - `inputSchema` — what data to return (if any)

     2. EXECUTE the directive fully (this is YOUR JOB as agent)

     3. When completionCondition is met, call `execution` with `action: "step"` with required
     data:
        ```
        execution({ action: "step", processId: "...", attemptId: "...", input: {
     ...data from inputSchema } })
        ```

     4. Receive next directive → repeat

     THIS IS KEY: The directive is not information for the user — it's
     YOUR INSTRUCTION. Execute it, then report back via execution's step action.

WHAT TO DO: directive — instruction to execute
WHEN READY: completionCondition — success completion criteria
HOW TO RESPOND: inputSchema — response structure

CRITICALLY IMPORTANT:

- Complete the current step FULLY before moving to the next one
- Even if it takes a long time — finish it to the end
- completionCondition must be satisfied 100%
- Call execution's step action only when EVERYTHING is ready
- Always use the Step attempt ID from the current presentation, even when input is empty. Never use
  an older attempt for a later presentation.
- Starting a workflow is two-phase: call `execution` with `action: "prepare"`, then call it with
  `action: "execute"` and the returned Start attempt ID. Retry that same execute call after a lost
  response; do not create a replacement preparation.
- `ATTEMPT_OUTCOME_UNKNOWN` must not be automatically retried. Inspect its Process ID through
  `execution` and cancel only through `cancel-execution` with the current revision when recovery
  requires retiring it.
- IF STEP INPUT SCHEMA REQUIRES INPUT FROM USER - GATHER THE INFO, DO NOT SIMPLY CALL STEP WITH RANDOM DATA.

PROHIBITED:

- Partial completion ("almost done")
- Moving forward with unfinished work
- Assumptions instead of verification. NEVER ASSUME, FOLLOW INSTRUCTIONS PRECISELY.

MANDATORY:

- When something is unclear, resolve it from the directive, the repository and your tools; ask the
  user only for a decision or a fact you cannot obtain yourself
- Pass input values with the types declared by the tool schema. Do not stringify an object or array unless the schema requires a string. If validation fails, inspect the actual value and correct its types.

SESSION ARCHIVING:

- If you archive a session during flow execution, then
  you MUST save a reminder for yourself in the archive,
  at its beginning and at its end, about the following:
  - execution ID (processId)
  - MCP server (e.g. moira, moira-local)
  - current workflow step

CRITICAL: Fill every required field you can produce yourself from the directive, the repository
and your own work. Only when the directive asks for a user decision, or for a fact only the user
has:
→ Display the directive, wait for the user's response, THEN call execution's step action.
→ Never invent the user's answer.
