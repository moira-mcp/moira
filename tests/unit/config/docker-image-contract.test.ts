import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";

describe("OSS image contract", () => {
  const dockerfile = readFileSync(resolve(process.cwd(), "config", "Dockerfile"), "utf8");
  const dockerignore = readFileSync(resolve(process.cwd(), ".dockerignore"), "utf8");
  const ci = readFileSync(resolve(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
  const e2e = readFileSync(resolve(process.cwd(), ".github", "workflows", "e2e.yml"), "utf8");
  const publish = readFileSync(
    resolve(process.cwd(), ".github", "workflows", "publish-image.yml"),
    "utf8",
  );
  const buildScript = readFileSync(
    resolve(process.cwd(), "scripts", "docker-build-and-run.sh"),
    "utf8",
  );

  test("exports the canonical parameterized runtime target", () => {
    expect(dockerfile).toContain("FROM core AS runtime");
    expect(dockerfile).toContain("ARG APP_BASE_PATH=/");
    expect(dockerfile).toContain("ARG MOIRA_HOST=localhost:8080");
    expect(dockerfile).toContain("ARG STATIC_ARTIFACTS_DOMAIN=static.localhost:8080");
    expect(dockerfile).toContain('ENTRYPOINT ["/app/scripts/container-entrypoint.sh"]');
  });

  test("does not accept or embed a deployment environment file", () => {
    expect(dockerfile).not.toContain("ARG ENV_FILE");
    expect(dockerfile).not.toContain("COPY ${ENV_FILE}");
    expect(dockerfile).toContain("COPY .env.example .env");
    expect(dockerfile).toContain("configuration: runtime-env");
  });

  test("excludes local env files and transfers selected runtime/release metadata", () => {
    expect(dockerignore).toContain(".env.*");
    expect(dockerignore).toContain("!.env.example");
    expect(ci).toContain("--env-file .env.ci");
    expect(e2e).toContain("--env-file .env.ci");
    expect(publish).toContain("GIT_COMMIT=${{ github.sha }}");
    expect(publish).toContain("id: build-time");
    expect(publish).toContain("date -u +%Y-%m-%dT%H:%M:%SZ");
    expect(publish).toContain("BUILD_TIME=${{ steps.build-time.outputs.value }}");
    expect(buildScript).toContain("node scripts/git-tree-identity.mjs");
    expect(buildScript).not.toContain("git rev-parse --short HEAD");
  });
});
