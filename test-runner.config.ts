/* eslint-disable no-restricted-syntax */
import { defineConfig } from "testfold";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { config as dotenvConfig } from "dotenv";

// Load .env.test for all suites (test-specific environment, separate from .env.local)
dotenvConfig({ path: ".env.test" });

// ---------------------------------------------------------------------------
// Helper: parse KEY=VALUE from env file content
// ---------------------------------------------------------------------------
function parseEnvVar(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^${key}=(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

// ---------------------------------------------------------------------------
// Helper: load env file and return raw content
// ---------------------------------------------------------------------------
function readEnv(filename: string): string {
  const p = resolve(process.cwd(), filename);
  if (!existsSync(p)) throw new Error(`Env file not found: ${filename}`);
  return readFileSync(p, "utf-8");
}

// ---------------------------------------------------------------------------
// Shared environment maps
// ---------------------------------------------------------------------------

/** Environments for API tests — URL without /mcp suffix */
const apiEnvironments = {
  local: {
    envFile: ".env.local",
    urlExtractor: (content: string) => {
      const port = parseEnvVar(content, "DOCKER_PORT");
      return port ? `http://localhost:${port}` : undefined;
    },
    // `.env.local` sets REMOTE_DOCKER_CONTEXT=mypc for the local→remote dev tunnel, but in
    // the `local` test environment the container runs on the LOCAL docker daemon. Override to
    // empty (highest-precedence layer in the child env) so docker exec / sqlite seeding in
    // tests/utils/docker-command.ts target the local container, not the remote PC.
    env: {
      REMOTE_DOCKER_CONTEXT: "",
    },
  },
  remote: {
    envFile: ".env.remote",
    urlExtractor: (content: string) => {
      const localContent = readEnv(".env.local");
      const port = parseEnvVar(localContent, "DOCKER_PORT");
      const host = parseEnvVar(content, "REMOTE_HOST");
      return port && host ? `http://${host}:${port}` : undefined;
    },
  },
};

/** Environments for E2E tests — same as API but remote uses localhost (browser runs locally) */
const e2eEnvironments = {
  ...apiEnvironments,
  remote: {
    envFile: ".env.remote",
    urlExtractor: (_content: string) => {
      const localContent = readEnv(".env.local");
      const port = parseEnvVar(localContent, "DOCKER_PORT");
      return port ? `http://localhost:${port}` : undefined;
    },
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export default defineConfig({
  artifactsDir: "./test-results/artifacts",
  testsDir: "./tests",
  parallel: true,
  failFast: false,

  reporters: ["console", "json", "markdown-failures", "timing", "timing-text", "summary-log"],

  hooks: {
    beforeSuite: async (suite) => {
      // MCP Tools: set MCP_SERVER_URL = TEST_BASE_URL + /mcp
      if (suite.name === "mcp-tools") {
        const baseUrl = process.env.TEST_BASE_URL;
        if (baseUrl) {
          process.env.MCP_SERVER_URL = `${baseUrl}/mcp`;
        }
      }

      const env = process.env.TESTFOLD_ENV;

      // Docker routing: tests use docker-command.ts which prefixes `docker --context <ctx>`
      // only when REMOTE_DOCKER_CONTEXT is set. `.env.local` ships REMOTE_DOCKER_CONTEXT=mypc
      // for the local→remote dev tunnel, but in the `local` test environment the container
      // runs on the LOCAL docker daemon. Clear the remote context so docker exec / sqlite
      // seeding target the local container instead of the (possibly offline) remote PC.
      // Remote/staging/prod keep their context untouched.
      if (env === "local") {
        delete process.env.REMOTE_DOCKER_CONTEXT;
      }

      // Remote mode guard: ensure .env.remote exists
      if (env === "remote" && suite.environments?.remote) {
        if (!existsSync(resolve(process.cwd(), ".env.remote"))) {
          return { ok: false, error: ".env.remote file not found. Create it for remote testing." };
        }
      }

      return { ok: true };
    },
  },

  suites: [
    {
      name: "unit",
      type: "jest",
      command:
        "npx jest --config=tests/config/jest.unit.config.js --json --outputFile=test-results/artifacts/unit.json",
      resultFile: "unit.json",
      env: {
        NODE_ENV: "test",
        NODE_OPTIONS: "--experimental-vm-modules",
      },
    },

    {
      name: "workflow",
      type: "jest",
      command:
        "npx jest --config=tests/config/jest.workflow.config.js --json --outputFile=test-results/artifacts/workflow.json",
      resultFile: "workflow.json",
      env: {
        NODE_ENV: "test",
        NODE_OPTIONS: "--experimental-vm-modules",
      },
    },

    {
      name: "integration",
      type: "jest",
      command:
        "npx jest --config=tests/config/jest.integration.config.js --json --outputFile=test-results/artifacts/integration.json",
      resultFile: "integration.json",
      env: {
        NODE_ENV: "test",
        NODE_OPTIONS: "--experimental-vm-modules",
        DB_PATH: "./data/test-integration.db",
        TELEGRAM_ENCRYPTION_KEY: "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
      },
    },

    {
      name: "api",
      type: "jest",
      command:
        "npx jest --config=tests/config/jest.api.config.js --json --outputFile=test-results/artifacts/api.json",
      resultFile: "api.json",
      env: {
        NODE_OPTIONS: "--experimental-vm-modules",
      },
      environments: apiEnvironments,
    },

    {
      name: "mcp-tools",
      type: "jest",
      command:
        "npx jest --config=tests/config/jest.mcp-tools.config.js --json --outputFile=test-results/artifacts/mcp-tools.json",
      resultFile: "mcp-tools.json",
      env: {
        NODE_OPTIONS: "--experimental-vm-modules",
      },
      environments: apiEnvironments,
    },

    {
      name: "e2e",
      type: "playwright",
      command: "npx playwright test --config=tests/config/playwright.config.ts",
      resultFile: "e2e.json",
      environments: e2eEnvironments,
    },
  ],
});
