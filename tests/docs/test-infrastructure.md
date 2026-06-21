# Test Infrastructure

## Architecture

All test suites are managed by **testfold** — a unified test runner configured in `test-runner.config.ts`.

### How It Works

1. `test-runner.config.ts` defines 6 suites with commands, env vars, and environment routing
2. `testfold` CLI orchestrates execution: runs suites (parallel or sequential), captures output, parses results
3. Built-in parsers (Jest, Playwright) extract structured results from JSON output
4. Built-in reporters generate console output, JSON summary, failure reports, timing stats

### Why testfold

- **10 scripts (~2000 lines JS) → 1 config file (~180 lines TS)**
- Declarative suite configuration instead of imperative scripts
- Built-in artifact cleanup, failure reports, timing stats
- CLI features: `--grep`, `--file`, `--dry-run`, `--fail-fast`, environment routing

---

## Running Tests

```bash
# All suites (parallel, remote env)
npm test

# All suites (local env)
npm run test:local

# Individual suites
npm run test:unit
npm run test:workflow
npm run test:integration

# Environment-routed suites
npm run test:api              # remote (default)
npm run test:api:local        # local Docker
npm run test:api:staging      # staging server
npm run test:api:prod         # production

# Direct testfold usage
npx testfold unit             # single suite
npx testfold unit workflow    # multiple suites
npx testfold --dry-run        # preview commands
npx testfold unit -- auth     # pass-through args (filter by file)
npx testfold -g "auth"        # grep by test name
```

---

## Output Files

Each test suite creates:

1. **JSON** - Raw framework output (e.g., `unit.json`)
2. **Log** - Full console output (e.g., `unit.log`)
3. **Timing** - Per-test timing statistics (e.g., `unit-timing.txt`)
4. **Failures/** - Individual `.md` per failed test (ANSI codes removed)

### Output Locations

```
test-results/artifacts/
├── unit.json              # Jest structured output
├── unit.log               # Full console (errors from crashed tests here)
├── unit-timing.txt        # Top 30 slowest tests + top 15 slow suites
├── integration.json
├── integration.log
├── integration-timing.txt
├── api.json
├── api.log
├── api-timing.txt
├── mcp-tools.json
├── mcp-tools.log
├── mcp-tools-timing.txt
├── e2e.json               # Playwright structured output
├── e2e.log
├── e2e-timing.txt         # Playwright timing report
└── failures/
    ├── unit/
    │   └── 01-test-name.md
    ├── integration/
    ├── api/
    ├── mcp-tools/
    └── e2e/
        └── 01-test-name.md

summary.json               # Aggregated results (project root)
test-summary.log            # ANSI-free summary log
timing.json                 # Timing data for all suites
```

---

## Artifact Cleanup

testfold cleans per-suite artifacts before each run. Running a single suite only cleans that suite's artifacts — previous runs of other suites are preserved.

---

## Performance Optimizations

### Compilation

Tests use **@swc/jest** instead of ts-jest for faster TypeScript compilation.

### Parallel Execution

| Category    | Workers | Notes                                 |
| ----------- | ------- | ------------------------------------- |
| Unit        | 2       | Memory-optimized for large test count |
| Integration | 5       | globalSetup creates DB once           |
| API         | 5       | Parallel HTTP requests                |
| MCP Tools   | 1       | Sequential (shared MCP state)         |
| E2E         | 1       | Sequential (browser context)          |

### Database

SQLite uses **WAL mode** with `synchronous=NORMAL` for better concurrent access.

---

## Configuration Files

### Test Runner Config

- `test-runner.config.ts` — testfold config with all 6 suites, environment routing, hooks

### Jest/Playwright Configs

- `tests/config/jest.base.config.js` - shared config with @swc/jest transform
- `tests/config/jest.unit.config.js`
- `tests/config/jest.workflow.config.js`
- `tests/config/jest.integration.config.js` - 5 workers + globalSetup
- `tests/config/jest.api.config.js` - 5 workers
- `tests/config/jest.mcp-tools.config.js`
- `tests/config/playwright.config.ts`

---

## Database Usage

| Test Type   | Database                     | Notes              |
| ----------- | ---------------------------- | ------------------ |
| Unit        | in-memory                    | No file            |
| Integration | `./data/test-integration.db` | Direct code access |
| API         | `./data/moira.db`            | Docker container   |
| MCP         | `./data/moira.db`            | Docker container   |
| E2E         | `./data/moira.db`            | Docker container   |

**Important:** API, MCP, E2E tests run against Docker container using production DB. Integration tests use separate test DB with direct code access.

---

## Environment Routing

Suites that require a running server (api, mcp-tools, e2e) support environment routing:

| Environment | Env File     | URL Source                |
| ----------- | ------------ | ------------------------- |
| local       | `.env.local` | `DOCKER_PORT` → localhost |

Usage: `npx testfold api -e staging` or `npm run test:api:staging`

---

## Adding New Test Category

1. Create config in `tests/config/jest.{category}.config.js`
2. Add suite entry to `test-runner.config.ts`
3. Add npm scripts to `package.json`
