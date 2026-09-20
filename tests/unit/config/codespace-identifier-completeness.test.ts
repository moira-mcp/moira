import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";

const root = process.cwd();
const sourceRoots = [
  "packages/mcp-server/src",
  "packages/shared/src",
  "packages/web-backend/src",
  "packages/web-frontend/src",
  "config",
];
const standaloneFiles = [
  ".env.example",
  ".env.local.example",
  "config/Dockerfile",
  "docker-compose.yml",
];
const sourceExtensions = new Set([
  ".conf",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
]);

function filesBelow(path: string): string[] {
  const absolute = resolve(root, path);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(absolute, entry.name);
    if (entry.isDirectory()) {
      const projectPath = relative(root, child);
      if (projectPath === "packages/mcp-server/src/help/content") return [];
      return filesBelow(projectPath);
    }
    return entry.isFile() && sourceExtensions.has(extname(entry.name)) ? [child] : [];
  });
}

describe("codespace identifier completeness", () => {
  test("keeps legacy workspace-domain identifiers out of executable and deployment surfaces", () => {
    const files = [
      ...sourceRoots.flatMap(filesBelow),
      ...standaloneFiles.map((file) => resolve(root, file)),
    ];
    const legacyPatterns = [
      /\bWORKSPACE_[A-Z0-9_]+\b/g,
      /\bworkspace_(?:id|connection|credential|authorization|resource|lifecycle|policy|provider|operation|transfer|file)\b/gi,
      /\b(?:workspace|Workspace)(?:Id|Connection|Credential|Authorization|Resource|Lifecycle|Policy|Provider|Operation|Transfer|File|Summary|Readiness|Guidance|Control)\b/g,
      /\bmanage_workspaces\b/g,
      /\bworkspace:(?:connect|create|start|stop|delete|cleanup|control|operation|transfer)\b/g,
      /\/api\/integrations\/github\/workspaces\b/g,
    ];
    const allowedCompatibility = new Set([
      "packages/web-backend/src/services/github-codespaces-connector.ts:WORKSPACE_FILE_REJECTED",
    ]);
    const violations: string[] = [];

    for (const file of files) {
      const projectPath = relative(root, file);
      const source = readFileSync(file, "utf8");
      for (const pattern of legacyPatterns) {
        for (const match of source.matchAll(pattern)) {
          const key = `${projectPath}:${match[0]}`;
          if (!allowedCompatibility.has(key)) violations.push(key);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
