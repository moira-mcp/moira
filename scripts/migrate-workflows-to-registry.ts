/**
 * One-off migration: convert production workflow JSON files from legacy
 * start-node `initialData.variables` to the new global `variableRegistry`.
 *
 * - Idempotent: a workflow that already has a `variableRegistry` is skipped.
 * - Missing-tolerant: operates on whatever JSON files exist under the two
 *   production folders; it does not require any DB or network.
 * - Bumps the workflow's metadata.version patch number when it changes content,
 *   so the deploy-time loader picks the migrated definition up.
 *
 * Run: npx tsx scripts/migrate-workflows-to-registry.ts [--dry]
 */
import * as fs from "fs";
import * as path from "path";
import { convertWorkflowToRegistry } from "../packages/workflow-engine/src/templates/registry-converter.js";

const DRY = process.argv.includes("--dry");

const ROOTS = [
  path.resolve("workflows/production/public"),
  path.resolve("workflows/production/private"),
];

function bumpPatch(version: unknown): string {
  if (typeof version !== "string") return "0.0.1";
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) return version;
  const [, maj, min, pat, rest] = m;
  return `${maj}.${min}.${Number(pat) + 1}${rest}`;
}

let total = 0;
let migrated = 0;
let skipped = 0;

for (const root of ROOTS) {
  if (!fs.existsSync(root)) {
    // Missing-tolerant: a folder absent in this checkout is fine.
    continue;
  }
  const files = fs.readdirSync(root).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    total++;
    const filePath = path.join(root, file);
    const raw = fs.readFileSync(filePath, "utf-8");
    const workflow = JSON.parse(raw) as {
      metadata?: { version?: string };
      variableRegistry?: unknown;
    };

    const { workflow: converted, changed, variableCount } = convertWorkflowToRegistry(workflow);

    if (!changed) {
      skipped++;
      continue;
    }

    if (converted.metadata) {
      converted.metadata.version = bumpPatch(converted.metadata.version);
    }

    migrated++;
    const out = JSON.stringify(converted, null, 2) + "\n";
    if (DRY) {
      console.log(
        `[dry] ${file}: +registry(${variableCount}) version→${converted.metadata?.version}`,
      );
    } else {
      fs.writeFileSync(filePath, out);
      console.log(
        `migrated ${file}: +registry(${variableCount}) version→${converted.metadata?.version}`,
      );
    }
  }
}

console.log(`\nTotal: ${total}, migrated: ${migrated}, skipped(already had registry): ${skipped}`);
