# Claude Code Commands

Custom slash commands for Claude Code workflow automation.

## Installation

Create symlink to your global Claude commands directory:

```bash
ln -s /path/to/mcp-moira/commands/resume-workflow.md ~/.claude/commands/resume-workflow.md
```

## Commands

### /resume-workflow

Resume Moira workflow execution from workspace context.

**Algorithm:**

1. Search for `process-id.txt` in `./moira-ws/*/`
2. If multiple workspaces found: ask user which to resume
3. Read process ID from file
4. Query Moira for current step via `mcp__moira__session` (action: "current_step")
5. Assess completion and continue workflow

**Usage:**

```
/resume-workflow                    # Auto-detect from ./moira-ws/
/resume-workflow <process-id>       # Explicit process ID
```

**Workspace format:**

```
./moira-ws/{feature_name}-{YYYYMMDD}-{HHMM}/
├── process-id.txt
├── development-plan.md
└── step-N/
    └── iteration-N/
```

**Requirements:**

- Workspace directory with `process-id.txt` in `./moira-ws/`
- Moira MCP server must be configured

### /start-development

Start development workflow process in Moira.

**Algorithm:**

1. List available workflows from Moira
2. Find development workflow (v7 or latest)
3. Start workflow and get process ID
4. Begin executing first step

**Usage:**

```
/start-development
```

### /finish-feature

Start feature completion workflow in Moira.

**Algorithm:**

1. List available workflows from Moira
2. Find feature completion workflow
3. Start workflow and get process ID
4. Execute feature completion steps

**Usage:**

```
/finish-feature
```
