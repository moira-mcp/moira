/**
 * Prompt Migration with SHA-256 Hash-Based Conflict Detection
 *
 * Manages system prompts as files with hash-based protection against
 * accidental overwrites of manually edited prompts during deployment.
 *
 * Flow:
 * 1. Prompt files live in config/prompts/ (version-controlled)
 * 2. Hash manifest lives alongside DB (persistent, not in git)
 * 3. On migration: compare DB values against manifest to detect manual edits
 * 4. If DB was manually edited → fail with clear error
 * 5. If DB matches manifest → safe to update from files
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { getStaticArtifactsDomain, getBaseUrl } from "@mcp-moira/shared";

// --- Types ---

export interface ManifestEntry {
  hash: string;
  updatedAt: number;
}

export interface Manifest {
  version: 1;
  entries: Record<string, ManifestEntry>;
}

export interface PromptMapping {
  dbKey: string;
  filePath: string; // relative to promptsDir
  label: string;
  description: string;
  category: string;
  sortOrder: number;
}

export interface PromptMigrationConfig {
  dbPath: string;
  promptsDir: string;
  manifestPath: string;
}

export interface MigrationResult {
  inserted: string[];
  updated: string[];
  unchanged: string[];
  conflicts: string[];
  skipped: string[];
}

// --- Constants ---

const TOOL_NAMES = [
  "list",
  "start",
  "step",
  "manage",
  "help",
  "settings",
  "token",
  "session",
  "notes",
  "artifacts",
  "lock",
] as const;

const TOOL_METADATA: Record<string, { label: string; sortOrder: number }> = {
  list: { label: "List Workflows", sortOrder: 20 },
  start: { label: "Start Workflow", sortOrder: 21 },
  step: { label: "Execute Step", sortOrder: 22 },
  manage: { label: "Manage Workflow", sortOrder: 23 },
  help: { label: "Get Help", sortOrder: 24 },
  settings: { label: "Settings", sortOrder: 25 },
  token: { label: "Create Token", sortOrder: 26 },
  session: { label: "Session Info", sortOrder: 27 },
  notes: { label: "Manage Notes", sortOrder: 28 },
  artifacts: { label: "Manage Artifacts", sortOrder: 29 },
  lock: { label: "Manage Locks", sortOrder: 30 },
};

// --- Prompt Mappings ---

function getDefaultMappings(): PromptMapping[] {
  const mappings: PromptMapping[] = [
    {
      dbKey: "mcp.systemReminder",
      filePath: "systemReminder.md",
      label: "System Reminder",
      description: "Text appended to every workflow step response. Guides agent behavior.",
      category: "mcp",
      sortOrder: 0,
    },
    {
      dbKey: "mcp.systemPrompt",
      filePath: "systemPrompt.md",
      label: "System Prompt",
      description: "Main system prompt for MCP instructions.",
      category: "mcp",
      sortOrder: 10,
    },
  ];

  // Tool descriptions
  for (const name of TOOL_NAMES) {
    const meta = TOOL_METADATA[name];
    mappings.push({
      dbKey: `mcp.toolDescription.${name}`,
      filePath: `toolDescriptions/${name}.md`,
      label: meta.label,
      description: `Description for MCP tool: ${name}`,
      category: "mcp",
      sortOrder: meta.sortOrder,
    });
  }

  // Error messages and validation help
  mappings.push({
    dbKey: "mcp.errorMessages",
    filePath: "errorMessages.json",
    label: "Error Messages",
    description: "Static error messages as JSON. Messages with parameters remain in code.",
    category: "mcp",
    sortOrder: 31,
  });

  mappings.push({
    dbKey: "mcp.validationHelp",
    filePath: "validationHelp.json",
    label: "Validation Help",
    description: "Validation help messages as JSON. Organized by category.",
    category: "mcp",
    sortOrder: 32,
  });

  return mappings;
}

/**
 * Scan agents/ directory for agent-level and model-level override files.
 * Directory structure:
 *   agents/{agent}/systemPrompt.md      → mcp.agent.{agent}.systemPrompt
 *   agents/{agent}/systemReminder.md    → mcp.agent.{agent}.systemReminder
 *   agents/{agent}/toolDescriptions/{tool}.md → mcp.agent.{agent}.toolDescription.{tool}
 *   agents/{agent}/models/{model}/systemPrompt.md   → mcp.agent.{agent}.model.{model}.systemPrompt
 *   agents/{agent}/models/{model}/systemReminder.md → mcp.agent.{agent}.model.{model}.systemReminder
 *   agents/{agent}/models/{model}/toolDescriptions/{tool}.md → mcp.agent.{agent}.model.{model}.toolDescription.{tool}
 */
function getAgentOverrideMappings(promptsDir: string): PromptMapping[] {
  const agentsDir = path.join(promptsDir, "agents");
  if (!fs.existsSync(agentsDir)) return [];

  const mappings: PromptMapping[] = [];
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const agentDirs = fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const agent of agentDirs) {
    const agentPath = path.join("agents", agent);

    // Agent-level systemPrompt
    if (fs.existsSync(path.join(promptsDir, agentPath, "systemPrompt.md"))) {
      mappings.push({
        dbKey: `mcp.agent.${agent}.systemPrompt`,
        filePath: `${agentPath}/systemPrompt.md`,
        label: `${capitalize(agent)} - System Prompt`,
        description: `System prompt override for ${agent} agent`,
        category: "mcp-agent-prompts",
        sortOrder: 0,
      });
    }

    // Agent-level systemReminder
    if (fs.existsSync(path.join(promptsDir, agentPath, "systemReminder.md"))) {
      mappings.push({
        dbKey: `mcp.agent.${agent}.systemReminder`,
        filePath: `${agentPath}/systemReminder.md`,
        label: `${capitalize(agent)} - System Reminder`,
        description: `System reminder override for ${agent} agent`,
        category: "mcp-agent-prompts",
        sortOrder: 0,
      });
    }

    // Agent-level tool description overrides
    const agentToolsDir = path.join(promptsDir, agentPath, "toolDescriptions");
    if (fs.existsSync(agentToolsDir)) {
      const toolFiles = fs.readdirSync(agentToolsDir).filter((f) => f.endsWith(".md"));
      for (const toolFile of toolFiles) {
        const toolName = toolFile.replace(".md", "");
        mappings.push({
          dbKey: `mcp.agent.${agent}.toolDescription.${toolName}`,
          filePath: `${agentPath}/toolDescriptions/${toolFile}`,
          label: `${capitalize(agent)} - ${toolName}`,
          description: `Tool description override for ${toolName} (${agent} agent)`,
          category: "mcp-agent-prompts",
          sortOrder: 0,
        });
      }
    }

    // Model-level overrides
    const modelsDir = path.join(promptsDir, agentPath, "models");
    if (fs.existsSync(modelsDir)) {
      const modelDirs = fs
        .readdirSync(modelsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const model of modelDirs) {
        const modelPath = `${agentPath}/models/${model}`;

        if (fs.existsSync(path.join(promptsDir, modelPath, "systemPrompt.md"))) {
          mappings.push({
            dbKey: `mcp.agent.${agent}.model.${model}.systemPrompt`,
            filePath: `${modelPath}/systemPrompt.md`,
            label: `${capitalize(agent)}/${model} - System Prompt`,
            description: `System prompt override for ${agent}/${model}`,
            category: "mcp-model-prompts",
            sortOrder: 0,
          });
        }

        if (fs.existsSync(path.join(promptsDir, modelPath, "systemReminder.md"))) {
          mappings.push({
            dbKey: `mcp.agent.${agent}.model.${model}.systemReminder`,
            filePath: `${modelPath}/systemReminder.md`,
            label: `${capitalize(agent)}/${model} - System Reminder`,
            description: `System reminder override for ${agent}/${model}`,
            category: "mcp-model-prompts",
            sortOrder: 0,
          });
        }

        const modelToolsDir = path.join(promptsDir, modelPath, "toolDescriptions");
        if (fs.existsSync(modelToolsDir)) {
          const toolFiles = fs.readdirSync(modelToolsDir).filter((f) => f.endsWith(".md"));
          for (const toolFile of toolFiles) {
            const toolName = toolFile.replace(".md", "");
            mappings.push({
              dbKey: `mcp.agent.${agent}.model.${model}.toolDescription.${toolName}`,
              filePath: `${modelPath}/toolDescriptions/${toolFile}`,
              label: `${capitalize(agent)}/${model} - ${toolName}`,
              description: `Tool description override for ${toolName} (${agent}/${model})`,
              category: "mcp-model-prompts",
              sortOrder: 0,
            });
          }
        }
      }
    }
  }

  return mappings;
}

export function getPromptMappings(promptsDir?: string): PromptMapping[] {
  const defaults = getDefaultMappings();
  if (!promptsDir) return defaults;
  return [...defaults, ...getAgentOverrideMappings(promptsDir)];
}

// --- Hash Utilities ---

export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

// --- Template Processing ---

export function processTemplateVariables(content: string): string {
  return content
    .replace(/\{\{ARTIFACTS_DOMAIN\}\}/g, getStaticArtifactsDomain())
    .replace(/\{\{BASE_URL\}\}/g, getBaseUrl());
}

// --- Manifest Operations ---

export function readManifest(manifestPath: string): Manifest {
  if (!fs.existsSync(manifestPath)) {
    return { version: 1, entries: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return { version: 1, entries: {} };
  }
}

export function writeManifest(manifestPath: string, manifest: Manifest): void {
  const dir = path.dirname(manifestPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

// --- Core Migration Logic ---

export function migratePrompts(config: PromptMigrationConfig): MigrationResult {
  const { dbPath, promptsDir, manifestPath } = config;

  const sqlite = new Database(dbPath);
  const manifest = readManifest(manifestPath);
  const mappings = getPromptMappings(promptsDir);
  const now = Date.now();

  const result: MigrationResult = {
    inserted: [],
    updated: [],
    unchanged: [],
    conflicts: [],
    skipped: [],
  };

  try {
    // Wrap all DB operations in a single synchronous transaction for atomicity.
    // If any unexpected error occurs (e.g. TypeError), all changes roll back.
    const runMigration = sqlite.transaction(() => {
      for (const mapping of mappings) {
        const fullFilePath = path.join(promptsDir, mapping.filePath);

        // Check if prompt file exists
        if (!fs.existsSync(fullFilePath)) {
          console.log(`  ⚠️  Prompt file not found: ${mapping.filePath}`);
          result.skipped.push(mapping.dbKey);
          continue;
        }

        // Read and process file content
        const rawContent = fs.readFileSync(fullFilePath, "utf-8");
        const fileContent = processTemplateVariables(rawContent);

        // Get current DB value (value is nullable in globalSetting)
        const dbRow = sqlite
          .prepare("SELECT value FROM globalSetting WHERE key = ?")
          .get(mapping.dbKey) as { value: string | null } | undefined;

        if (!dbRow) {
          // No DB value — fresh install for this key
          sqlite
            .prepare(
              `INSERT INTO globalSetting (key, value, type, label, description, category, sortOrder, updatedAt)
               VALUES (?, ?, 'text', ?, ?, ?, ?, ?)`,
            )
            .run(
              mapping.dbKey,
              fileContent,
              mapping.label,
              mapping.description,
              mapping.category,
              mapping.sortOrder,
              now,
            );

          manifest.entries[mapping.dbKey] = { hash: computeHash(fileContent), updatedAt: now };
          result.inserted.push(mapping.dbKey);
          continue;
        }

        // DB has a value — check against manifest
        // Handle null DB values gracefully (treat as empty string for hashing)
        const dbHash = computeHash(dbRow.value ?? "");
        const manifestEntry = manifest.entries[mapping.dbKey];

        if (!manifestEntry) {
          // First time tracking this key — record DB hash as baseline
          // DO NOT update the DB value regardless of whether file content differs.
          // We can't tell if DB was manually edited, so preserve it.
          manifest.entries[mapping.dbKey] = { hash: dbHash, updatedAt: now };

          const fileHash = computeHash(fileContent);
          if (fileHash !== dbHash) {
            // File differs from DB — log warning for admin visibility
            // On next deploy, if DB is unchanged, the update will apply safely
            console.warn(
              `  ⚠️  Baseline recorded for ${mapping.dbKey}: file differs from DB value. ` +
                `DB value preserved. Update will apply on next deploy if DB is not edited manually.`,
            );
          }
          result.unchanged.push(mapping.dbKey);
          continue;
        }

        // Manifest entry exists — normal hash comparison
        const fileHash = computeHash(fileContent);

        if (dbHash === manifestEntry.hash) {
          // DB was NOT manually edited (matches what we last deployed)
          if (fileHash === manifestEntry.hash) {
            // File unchanged too — nothing to do
            result.unchanged.push(mapping.dbKey);
          } else {
            // File changed, safe to update DB
            sqlite
              .prepare("UPDATE globalSetting SET value = ?, updatedAt = ? WHERE key = ?")
              .run(fileContent, now, mapping.dbKey);
            manifest.entries[mapping.dbKey] = { hash: fileHash, updatedAt: now };
            result.updated.push(mapping.dbKey);
          }
        } else {
          // DB was manually edited! Hash mismatch = conflict
          result.conflicts.push(mapping.dbKey);
        }
      }
    });

    runMigration();
  } finally {
    sqlite.close();
  }

  // Only write manifest if no conflicts
  if (result.conflicts.length === 0) {
    writeManifest(manifestPath, manifest);
  }

  return result;
}

// --- Integration with run-migrations.ts ---

export function runPromptMigration(dbPath: string): void {
  const promptsDir = path.resolve("./config/prompts");
  const manifestPath = path.join(path.dirname(path.resolve(dbPath)), "prompt-manifest.json");

  console.log("📝 Running prompt migration with hash-based protection...");
  console.log(`  Prompts directory: ${promptsDir}`);
  console.log(`  Manifest: ${manifestPath}`);

  if (!fs.existsSync(promptsDir)) {
    console.error("  ❌ Prompts directory not found:", promptsDir);
    console.error("     Make sure config/prompts/ exists with prompt files");
    process.exit(1);
  }

  const result = migratePrompts({ dbPath, promptsDir, manifestPath });

  // Report results
  if (result.inserted.length > 0) {
    console.log(`  ✅ Inserted ${result.inserted.length} new prompts:`);
    for (const key of result.inserted) {
      console.log(`     + ${key}`);
    }
  }

  if (result.updated.length > 0) {
    console.log(`  ✅ Updated ${result.updated.length} prompts:`);
    for (const key of result.updated) {
      console.log(`     ~ ${key}`);
    }
  }

  if (result.unchanged.length > 0) {
    console.log(`  ⏭️  ${result.unchanged.length} prompts unchanged`);
  }

  if (result.skipped.length > 0) {
    console.log(`  ⚠️  Skipped ${result.skipped.length} prompts (file not found):`);
    for (const key of result.skipped) {
      console.log(`     ? ${key}`);
    }
  }

  if (result.conflicts.length > 0) {
    const isFatal = process.env.PROMPT_CONFLICT_FATAL === "1";

    console.error("");
    console.error(
      `  ${isFatal ? "❌" : "⚠️"} PROMPT CONFLICT: The following prompts were manually edited in the database`,
    );
    console.error("     but the deployment has different file-based versions:");
    console.error("");
    for (const key of result.conflicts) {
      // Find the prompt file path for this key
      const mapping = getPromptMappings(promptsDir).find((m) => m.dbKey === key);
      const filePath = mapping ? `config/prompts/${mapping.filePath}` : key;
      console.error(`     ⚠️  ${key} (file: ${filePath})`);
    }
    console.error("");
    console.error("  Промпт был изменён в БД (через API/UI) после последнего деплоя.");
    console.error("  Новая файловая версия тоже отличается от последнего деплоя.");
    console.error("");
    console.error("  Что делать:");
    console.error("  1. Проверьте даты изменения файла локально и значения в БД на сервере");
    console.error("  2. Решите какая версия актуальная:");
    console.error("     a) Если серверная (DB) — скачайте её локально:");
    for (const key of result.conflicts) {
      const mapping = getPromptMappings(promptsDir).find((m) => m.dbKey === key);
      const filePath = mapping ? `config/prompts/${mapping.filePath}` : key;
      console.error(
        `        sqlite3 ./data/moira.db "SELECT value FROM globalSetting WHERE key = '${key}'"`,
      );
      console.error(`        Сохраните результат в ${filePath}`);
    }
    console.error(
      "     b) Если файловая — удалите конфликтующие записи из ./data/prompt-manifest.json на сервере",
    );
    console.error("  3. Повторите деплой");
    console.error("");

    if (isFatal) {
      // Pre-deploy mode: abort to prevent deploy with unresolved conflicts
      process.exit(1);
    } else {
      // Container startup mode (second line of defense): warn and continue
      // Keep DB version, don't crash the app
      console.warn("  ℹ️  Keeping DB versions for conflicting prompts (container startup mode).");
      console.warn("  ℹ️  Resolve conflicts before next deploy.");
    }
  }
}
