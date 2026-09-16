/**
 * One-time upgrade of persisted workflow definitions to the current schema version.
 *
 * Runs at startup before the bundled catalog is reconciled and before the validation cache is
 * rebuilt. It rewrites, in one transaction, every stored place that holds a definition:
 *  - `workflow.graph` (the definition revision advances, as for any stored write of the graph);
 *  - `managedWorkflowBaseline.state` (the baseline the catalog loader compares against);
 *  - `workflowReconciliationConflict.previousState/currentState/incomingState`.
 * With all three upgraded, the loader's three-way comparison sees migrated content on every side
 * and an unchanged bundled entry is neither classified as a user change nor rewritten.
 *
 * Idempotent: a row already at the current version is left untouched.
 */

import type Database from "better-sqlite3";
import { migrateWorkflowGraph } from "@mcp-moira/workflow-engine/migration";
import { createLogger } from "../logging/logger.js";

export interface StoredDefinitionUpgradeResult {
  workflows: number;
  baselines: number;
  conflicts: number;
}

type AnyRecord = Record<string, unknown>;

function upgradeStateJson(json: string | null): string | null {
  if (json === null) return null;
  const state = JSON.parse(json) as { lifecycle?: string; content?: { graph?: unknown } };
  if (!state || state.lifecycle === "absent" || !state.content) return null;
  const migration = migrateWorkflowGraph(state.content.graph as AnyRecord);
  if (!migration.changed) return null;
  return JSON.stringify({ ...state, content: { ...state.content, graph: migration.graph } });
}

export function upgradeStoredWorkflowDefinitions(
  sqlite: Database.Database,
): StoredDefinitionUpgradeResult {
  const logger = createLogger({ component: "WorkflowDefinitionUpgrade" });
  const result: StoredDefinitionUpgradeResult = { workflows: 0, baselines: 0, conflicts: 0 };
  const run = sqlite.transaction(() => {
    const workflows = sqlite.prepare("SELECT id, graph FROM workflow").all() as Array<{
      id: string;
      graph: string;
    }>;
    const updateWorkflow = sqlite.prepare(
      "UPDATE workflow SET graph = ?, revision = revision + 1 WHERE id = ?",
    );
    for (const row of workflows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.graph);
      } catch {
        continue; // A malformed row is the validation cache's finding, not a migration target.
      }
      const migration = migrateWorkflowGraph(parsed as AnyRecord);
      if (!migration.changed) continue;
      updateWorkflow.run(JSON.stringify(migration.graph), row.id);
      result.workflows += 1;
    }

    const baselines = sqlite
      .prepare("SELECT ownerId, slug, state FROM managedWorkflowBaseline")
      .all() as Array<{ ownerId: string; slug: string; state: string }>;
    const updateBaseline = sqlite.prepare(
      "UPDATE managedWorkflowBaseline SET state = ? WHERE ownerId = ? AND slug = ?",
    );
    for (const row of baselines) {
      const upgraded = upgradeStateJson(row.state);
      if (upgraded === null) continue;
      updateBaseline.run(upgraded, row.ownerId, row.slug);
      result.baselines += 1;
    }

    const conflicts = sqlite
      .prepare(
        "SELECT ownerId, slug, previousState, currentState, incomingState FROM workflowReconciliationConflict",
      )
      .all() as Array<{
      ownerId: string;
      slug: string;
      previousState: string | null;
      currentState: string;
      incomingState: string;
    }>;
    const updateConflict = sqlite.prepare(
      "UPDATE workflowReconciliationConflict SET previousState = ?, currentState = ?, incomingState = ? WHERE ownerId = ? AND slug = ?",
    );
    for (const row of conflicts) {
      const previous = upgradeStateJson(row.previousState);
      const current = upgradeStateJson(row.currentState);
      const incoming = upgradeStateJson(row.incomingState);
      if (previous === null && current === null && incoming === null) continue;
      updateConflict.run(
        previous ?? row.previousState,
        current ?? row.currentState,
        incoming ?? row.incomingState,
        row.ownerId,
        row.slug,
      );
      result.conflicts += 1;
    }
  });
  run();
  if (result.workflows + result.baselines + result.conflicts > 0) {
    logger.info("Upgraded stored workflow definitions to the current schema version", {
      ...result,
    });
  }
  return result;
}
