# Development Flow V7 - Companion Documents

List of the project-specific documents the workflow references and that the agent may create while it works.

## Required Project Documents

These documents are expected to exist in the project. The workflow references them for validation and to follow project standards.

### 1. Project study

- **`docs/AGENT-ONBOARDING.md`** - Project study guide for AI agents
  - Used by: node `study-project-foundation`
  - Contains: phased study instructions, verification checklist, run commands

- **`README.md`** - Main project documentation
  - Used by: `study-project-foundation`, `restart-and-rebuild`
  - Contains: quick start, architecture, deployment

### 2. Starting and restarting the system

- **`docs/deployment/SYSTEM-RESTART.md`** - System restart instructions
  - Used by: node `restart-and-rebuild`
  - Contains: what to do, how to verify correctness

- **`docs/DEVELOPMENT.md`** - Development workflow
  - Used by: `restart-and-rebuild`
  - Contains: npm commands, testing strategy, production deployment

### 3. Documentation standards

- **`docs/DOCUMENTATION-STYLE-GUIDE.md`** - Documentation formatting rules
  - Used by: `validate-documentation`, `update-step-documentation`, `update-documentation`
  - Contains: FORBIDDEN (history, marketing), REQUIRED (facts, examples, commands)

### 4. Checklists and validation

- **`docs/PROJECT_CHECKLIST.md`** - Mandatory pre-commit checks
  - Used by: node `check-project-checklist`
  - Contains: check categories (audit trail, env vars, Docker ports, API limits, logging, frontend guards, and more)

### 5. Testing

- **`docs/TESTING.md`** - Testing rules
  - Used by: nodes that work with tests
  - Contains: no hardcoded URLs, use `getTestBaseUrl()`, database setup

## Documents Created by the Workflow

These files are created automatically by the workflow as it runs.

### Feature development structure

```
./{{feature_name}}/
├── development-plan.md              # Feature development plan
├── step-{{N}}/
│   ├── iteration-{{M}}/
│   │   ├── code-quality-architecture.md    # Quality check results
│   │   ├── implementation.md               # Implementation details
│   │   └── tests.md                        # Test results
│   └── step-documentation.md        # Documentation written at step completion
└── final-summary.md                 # Final feature report
```

### Development plan (`development-plan.md`)

Created by: node `analyze-and-plan`
Contains: development stages, completion criteria, dependencies

### Quality check (`code-quality-architecture.md`)

Created by: node `check-code-quality-and-architecture`
Contains: code standards and architectural aspects, violations found

### Testing (`tests.md`)

Created by: node `write-new-tests-action`
Contains: tests created, run results, coverage

### Step documentation (`step-documentation.md`)

Created by: node `update-step-documentation`
Contains: description of what was implemented, API changes, usage examples

### Final report (`final-summary.md`)

Created by: node `update-documentation`
Contains: summary of the whole feature, updated project documentation

## Optional Documents

May exist but are not required:

- **`CHECKLIST.md`** (at the root) - Alternative checklist location
- **`docs/`** (folder) - Any additional documentation
- **Build/deploy scripts** - `package.json`, `Makefile`

## Rules for Workflow Universality

The workflow is designed to work across different projects:

1. **Directives do not hardcode paths** - the agent locates the documents itself
2. **Fallback instructions** - if a document is not found, the agent applies general rules
3. **Project-specific search** - checks typical locations (docs/, root)
4. **Flexible names** - accepts variations (DEVELOPMENT.md, README.md, etc.)
