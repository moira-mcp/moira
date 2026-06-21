# Issues Management: Work Plan

## Goal

Simplify issue management in MCP Moira:

- Replace the outdated `pre-alpha`/`post-alpha` scheme
- Minimum labels, maximum usefulness
- A convenient Kanban board in GitHub Projects

## Final Label Scheme

### Priority (2 labels)

| Label           | Color     | When                  |
| --------------- | --------- | --------------------- |
| `priority:high` | `#D93F0B` | Urgent, blocks work   |
| `priority:low`  | `#0E8A16` | Someday, nice to have |

No label = normal priority (most issues).

### Type (4 labels)

| Label          | Color     | Description                     |
| -------------- | --------- | ------------------------------- |
| `type:bug`     | `#D73A4A` | Something doesn't work          |
| `type:feature` | `#A2EEEF` | New functionality               |
| `type:docs`    | `#0075CA` | Documentation                   |
| `type:chore`   | `#FEF2C0` | CI/CD, refactoring, maintenance |

### Component (keep as-is)

The existing `component:*` labels work — leave them untouched.

### Remove

- `pre-alpha` — outdated
- `post-alpha` — outdated
- `bug` → replace with `type:bug`
- `enhancement` → replace with `type:feature` or `type:chore`
- `documentation` → replace with `type:docs`
- `duplicate`, `invalid`, `wontfix`, `question`, `help wanted` — unused

## GitHub Project Board

Create a "Development" board with these columns:

- **Backlog** — all new issues
- **Todo** — taken into the current sprint
- **In Progress** — in progress
- **Done** — completed

Automation:

- New issues → Backlog
- PR linked → In Progress
- PR merged / issue closed → Done

---

## Execution Plan

### Step 1: Create the new labels

```bash
gh label create "priority:high" --color "D93F0B" --description "Urgent, blocks work"
gh label create "priority:low" --color "0E8A16" --description "Nice to have"
gh label create "type:bug" --color "D73A4A" --description "Something doesn't work"
gh label create "type:feature" --color "A2EEEF" --description "New functionality"
gh label create "type:docs" --color "0075CA" --description "Documentation"
gh label create "type:chore" --color "FEF2C0" --description "CI/CD, refactoring, maintenance"
```

### Step 2: Migrate existing issues

**bug → type:bug:**

```bash
gh issue list --label "bug" --state open --json number -q '.[].number' | xargs -I {} gh issue edit {} --remove-label "bug" --add-label "type:bug"
```

**enhancement → type:feature:**

```bash
gh issue list --label "enhancement" --state open --json number -q '.[].number' | xargs -I {} gh issue edit {} --remove-label "enhancement" --add-label "type:feature"
```

**documentation → type:docs:**

```bash
gh issue list --label "documentation" --state open --json number -q '.[].number' | xargs -I {} gh issue edit {} --remove-label "documentation" --add-label "type:docs"
```

**pre-alpha → priority:high:**

```bash
gh issue list --label "pre-alpha" --state open --json number -q '.[].number' | xargs -I {} gh issue edit {} --remove-label "pre-alpha" --add-label "priority:high"
```

**post-alpha → remove (no replacement):**

```bash
gh issue list --label "post-alpha" --state open --json number -q '.[].number' | xargs -I {} gh issue edit {} --remove-label "post-alpha"
```

### Step 3: Delete the old labels

```bash
gh label delete "bug" --yes
gh label delete "enhancement" --yes
gh label delete "documentation" --yes
gh label delete "pre-alpha" --yes
gh label delete "post-alpha" --yes
gh label delete "duplicate" --yes
gh label delete "invalid" --yes
gh label delete "wontfix" --yes
gh label delete "question" --yes
gh label delete "help wanted" --yes
```

### Step 4: GitHub Project Board

1. Create a new "Development" Project (Board view)
2. Columns: Backlog, Todo, In Progress, Done
3. Add all open issues to Backlog
4. Configure automation:
   - Item added → Backlog
   - Item closed → Done

### Step 5: Documentation

Update/create:

- `CONTRIBUTING.md` — how to create and manage issues
- `docs/ISSUES-GUIDE.md` — full guide

---

## Checklist

- [ ] Step 1: Create the new labels (6 of them)
- [ ] Step 2: Migrate issues (5 commands)
- [ ] Step 3: Delete the old labels (10 of them)
- [ ] Step 4: Create the GitHub Project Board
- [ ] Step 5: Update the documentation
