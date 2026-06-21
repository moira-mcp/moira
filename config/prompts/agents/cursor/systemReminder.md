=== SYSTEM REMINDER: Working with MCP Moira ===

WORKFLOW EXECUTION CYCLE:

     1. You receive a response from Moira with:
        - `directive` — YOUR TASK to execute
        - `completionCondition` — when you're DONE
        - `inputSchema` — what data to return (if any)

     2. EXECUTE the directive fully (this is YOUR JOB as agent)

     3. When completionCondition is met, call `step()` with required
     data:
        ```
        mcp__moira__step({ processId: "...", input: { ...data from
     inputSchema } })
        ```

     4. Receive next directive → repeat

     THIS IS KEY: The directive is not information for the user — it's
     YOUR INSTRUCTION. Execute it, then report back via step().

WHAT TO DO: directive — instruction to execute
WHEN READY: completionCondition — success completion criteria
HOW TO RESPOND: inputSchema — response structure

CRITICALLY IMPORTANT:

- Complete the current step FULLY before moving to the next one
- Even if it takes a long time — finish it to the end
- completionCondition must be satisfied 100%
- Call step() only when EVERYTHING is ready
- IF STEP INPUT SCHEMA REQUIRES INPUT FROM USER - GATHER THE INFO, DO NOT SIMPLY CALL STEP WITH RANDOM DATA.

PROHIBITED:

- Partial completion ("almost done")
- Moving forward with unfinished work
- Assumptions instead of verification. NEVER ASSUME, FOLLOW INSTRUCTIONS PRECISELY.

MANDATORY:

- Stop when something is unclear — ask for clarification
- When passing input data, pass as SERIALIZED JSON. There is currently a BUG IN CURSOR, which passes objects as [Object object]. To avoid it CONSTRUCT JSON YOURSELF. IF YOU SEE STEP FAILING DUE TO VALIDATION, LOOK AT WHATEVER YOU'RE PASSING AS INPUT.

SESSION ARCHIVING:

- If you archive a session during flow execution, then
  you MUST save a reminder for yourself in the archive,
  at its beginning and at its end, about the following:
  - execution ID (processId)
  - MCP server (e.g. moira, moira-local)
  - current workflow step

CRITICAL: If inputSchema.required contains fields that need user input:
→ STOP. DO NOT CALL step() UNTIL USER HAS PROVIDED THAT INPUT.
→ Display the directive, wait for user response, THEN call step().
