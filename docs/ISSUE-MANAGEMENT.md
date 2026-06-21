# Issue Management

## General Rules

All ideas, tasks, bugs, and feature requests are tracked in **GitHub Issues**: https://github.com/moira-mcp/moira/issues

## Issue Format

### Title

**Must be concise and clear** — from the title alone it should be immediately obvious:

- What needs to be done
- Which problem is being solved
- Which component is affected

**Examples:**

✅ **Good:**

- "Add a linter for code quality"
- "Fix the current-user component — UI and functionality"
- "Create an onboarding workflow for new users"

❌ **Bad:**

- "Fix a bug"
- "Improve the system"
- "Add a feature"

### Description

**Must be detailed**, with examples:

#### Description structure:

1. **Problem** — what's wrong now
2. **Solution** — how we'll fix it
3. **Code examples** — concrete implementation examples
4. **Expected Result** — what we'll get in the end

#### Example:

\`\`\`markdown

## Problem

There is no automated code-quality check.

## Solution

### 1. ESLint Configuration

\`\`\`json
{
"extends": ["eslint:recommended"],
"rules": {
"no-unused-vars": "error"
}
}
\`\`\`

### 2. Pre-commit Hooks

- husky for git hooks
- lint-staged for staged files

## Expected Result

A unified code style across all packages
\`\`\`

### Labels

**Always** assign labels when creating an issue:

#### Component Labels

Indicate which component is affected:

- `component:backend` - Server logic, API, engine
- `component:frontend` - Web UI, dashboard
- `component:mcp` - MCP server integration
- `component:workflows` - Workflow system, templates
- `component:docs` - Documentation
- `component:landing` - Landing page
- `component:infrastructure` - Server setup, deployment, security, monitoring

**One-component rule:** Each issue should preferably have **only one** component label. If a task touches several components, it's better to split it into separate issues.

**Exceptions:** Multiple component labels are acceptable when:

- The task is small and tightly coupled (e.g., add a UI + API endpoint)
- Splitting it into separate issues would add unnecessary complexity

**Examples:**

✅ **Good (one component):**

- "Add a Profile Settings page" - only `component:frontend`
- "API for changing the password" - only `component:backend`

❌ **Bad (should be split):**

- "Implement a notification system" with labels `component:backend`, `component:frontend`, `component:mcp`
  → Split into: backend API, frontend UI, MCP integration

✅ **Acceptable (no need to split):**

- "Add a resend-email button with an API endpoint" - `component:frontend`, `component:backend`

#### Priority Labels

Indicate when it should be done:

- `pre-alpha` - Must do before alpha release
- `post-alpha` - Can do after alpha release

**IMPORTANT:** The `pre-alpha` and `post-alpha` labels are **mutually exclusive** — an issue can have only one of them.

#### Special Labels

- `epic` - Large architectural milestone requiring multiple issues
- `bug` - Something isn't working
- `enhancement` - New feature or request
- `duplicate` - This issue or pull request already exists

Epic issues require breaking down into smaller subtasks before work begins.

## GitHub Project

All issues are automatically added to the kanban board: <your GitHub project board>

### Columns:

- **📋 To Do** - Backlog tasks
- **🏗️ In Progress** - Being worked on
- **✅ Done** - Completed

### Filters:

To view a specific subset of issues, use filters:

\`\`\`
label:pre-alpha # Only pre-alpha tasks
label:component:frontend # Only frontend
label:epic # Only large tasks
\`\`\`

## Creating Issues

### When the user asks to record something

**IMPORTANT:** Don't create the issue right away. Clarify the details first:

- What exactly does the user mean?
- What's the expected result?
- Are there any specific requirements?
- Which components are affected?

**Example questions:**

- "Do you mean [X] or [Y]?"
- "What result do you want to see?"
- "Is this about the frontend or the backend?"
- "Can you give a usage example?"

### Creation command format

\`\`\`bash
gh issue create \\
--title "Concise title" \\
--body "Detailed description with examples" \\
--label "component:backend,component:frontend,pre-alpha" \\
-p "Moira Development"
\`\`\`

### Adding to the board

**ALWAYS** add every new issue to the "Moira Development" project board:

- Use the `-p "Moira Development"` flag when creating the issue
- If an issue was created without the flag, add it manually: `gh issue edit <number> --add-project "Moira Development"`
- All issues must be on the kanban board for progress tracking

## Best Practices

### Small Atomic Issues

Issues should be **small and atomic**:

✅ **Good:**

- "Add email verification"
- "Create a UI for change password"
- "Set up ESLint"

❌ **Bad (too large):**

- "Implement the entire authentication system"
- "Build the complete frontend"

### Epic Issues

If a task is too large, mark it as `epic` and break it into subtasks.

**Example:**

- Epic: "Build a public-workflows system with a marketplace"
- Subtasks:
  - "Add publish-workflow functionality"
  - "Create a marketplace UI"
  - "Add search and filters"
  - "Implement a rating system"

### In Pull Requests

A PR can close **several small issues**:

\`\`\`markdown
Closes #76, #77, #78

- Added a linter
- Cleaned up skipped tests
- Set up the build structure
  \`\`\`

## Issue Lifecycle

1. **Created** - Issue created with labels
2. **To Do** - In the backlog on the kanban board
3. **In Progress** - Someone is working on the issue
4. **Review** - PR created, under review
5. **Done** - PR merged, issue closed

## Working with Issues

### Take an issue into work

1. Move it to the "In Progress" column on the board
2. Or via the CLI:

```bash
# Assign yourself
gh issue edit <number> --add-assignee @me
```

### Change status

Drag the issue between columns on the kanban board:

- **To Do** → **In Progress** - started work
- **In Progress** → **Done** - finished

### Close an issue

```bash
# Close as completed
gh issue close <number>

# Close with a comment
gh issue close <number> --comment "Implemented in PR #123"

# Close as a duplicate
gh issue close <number> --comment "Duplicate of #456" --reason "not planned"

# Close as no longer relevant
gh issue close <number> --reason "not planned"
```

### Reopen an issue

```bash
gh issue reopen <number>
```

### Useful commands

```bash
# List open issues
gh issue list --state open

# List your in-progress issues
gh issue list --assignee @me --state open

# View issue details
gh issue view <number>

# Add a comment
gh issue comment <number> --body "Comment"

# Change labels
gh issue edit <number> --add-label "bug" --remove-label "enhancement"
```

## Closing Issues

Issues are closed automatically when a PR is merged if the PR contains:

\`\`\`markdown
Closes #123
\`\`\`

Or manually, with a comment explaining the reason for closing.
