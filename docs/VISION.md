# Product Vision

## Core Problems Moira Solves

### 1. Response Validation & Result Verification

**Problem:** Without validation, agents often:

- Complete tasks partially ("I've done most of it")
- Return results in wrong format
- Claim completion without actual proof
- Skip verification steps

**Solution:** JSON Schema validation at each step. Agent cannot proceed until response matches expected structure. Completion condition explicitly defines what "done" means.

### 2. Hallucination Protection

**Problem:** Agents sometimes:

- Invent facts or data that don't exist
- Claim to have done something they didn't
- Provide confident but incorrect information
- Make up file paths, function names, or results

**Solution:** Structured workflows force agents to provide verifiable outputs. Each step requires concrete evidence (file created, test passed, data returned). Schema validation catches fabricated responses.

### 3. Complex Routine Automation

**Problem:** Repetitive multi-step tasks require:

- Remembering all steps every time
- Maintaining consistency across executions
- Manual tracking of progress
- Re-explaining the process to AI each time

**Solution:** Workflows encode the entire process once. Agent executes consistently every time. No need to re-explain or remember steps.

### 4. Sequential Execution Guarantee

**Problem:** Agents tend to:

- Skip steps they consider "obvious"
- Jump ahead to interesting parts
- Forget earlier steps in long tasks
- Lose context mid-execution

**Solution:** Workflow engine controls step progression. Agent receives only current step directive. Cannot skip ahead. Context preserved automatically between steps.

### 5. Complete Task Execution

**Problem:** Without structure, agents often:

- Do 80% and declare "mostly done"
- Miss edge cases or cleanup steps
- Forget post-processing or verification
- Leave tasks in incomplete state

**Solution:** Workflow defines all required steps including verification and cleanup. Agent must complete each step with validated output before proceeding. No "mostly done" - either complete or not.

---

## Core Purpose

MCP Moira is an Agent Workflow Engine designed for **AI agents as primary users**.

The system enables agents to execute multi-step processes through MCP tools, receiving clear directives and success criteria at each step. Workflows guide agents through complex tasks without requiring human intervention.

## Primary Use Case

**Agent-native workflow execution:**

1. Agent connects to MCP Moira via MCP protocol
2. Agent starts a workflow using `start` tool
3. Agent receives directive and completion condition for current step
4. Agent performs the work autonomously
5. Agent submits result via `step` tool
6. Workflow engine evaluates result and advances to next step
7. Repeat until workflow completes

## Design Principles

**MCP-first architecture:**

- All core functionality accessible via MCP tools
- Web UI is supplementary, not primary interface
- Agents should be able to use Moira without ever opening a browser

**Clear agent instructions:**

- Each step provides explicit directive (what to do)
- Each step provides completion condition (when done)
- Optional input schema for structured responses
- No ambiguity in what agent should accomplish

**Minimal human intervention:**

- Workflows encode decision logic
- Condition nodes handle branching
- Agents execute, engine directs

## Target Users

**Primary:** AI agents (Claude, GPT, custom agents) via MCP protocol

**Secondary:** Humans managing workflows via Web UI

- Create and edit workflows
- Monitor executions
- View execution history
- Manage settings

## Integration Points

**MCP Clients:**

- Claude Desktop
- Claude Code
- MCP Inspector (testing)
- Custom MCP clients

**Authentication:**

- OAuth 2.1 for MCP clients
- Email/password for Web UI
- Session management across both

## Success Metrics

The product succeeds when:

- Agents can complete workflows without human help
- Workflow creation is intuitive for workflow designers
- MCP integration works reliably across different clients
- System scales to handle concurrent agent executions
