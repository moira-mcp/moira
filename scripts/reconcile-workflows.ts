#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  applyWorkflowReconciliationBundle,
  chooseWorkflowReconciliationBundleDecision,
  getDbPath,
  getSqliteInstance,
  getWorkflowMutationService,
  loadWorkflowReconciliationBundle,
  readWorkflowCatalogs,
  getWorkflowsDirs,
  readWorkflowReconciliationBundleCandidate,
  UserRepository,
  getDatabase,
  workflowReconciliationAgentInstructions,
  withWorkflowReconciliationBundleLock,
  type ManagedWorkflowState,
  type WorkflowReconciliationInstructionKind,
  WorkflowReconciliationBundleError,
  readWorkflowReconciliationBundleApplied,
  isWorkflowReconciliationBundleApplied,
} from "@mcp-moira/shared";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function recoveryRoot(): string {
  return path.join(path.dirname(path.resolve(getDbPath())), ".moira-reconciliation");
}

function buildIdentity(): string {
  for (const candidate of ["/app/BUILD_INFO", path.resolve("BUILD_INFO")]) {
    if (!fs.existsSync(candidate)) continue;
    const content = fs.readFileSync(candidate, "utf8");
    const commit = /^commit:\s*(.+)$/m.exec(content)?.[1]?.trim();
    if (commit) return commit;
  }
  return "development-local";
}

function remainingReferences(root: string): string[] {
  try {
    const bundle = loadWorkflowReconciliationBundle(root);
    const decided = new Set(bundle.decisions.decisions.map((item) => item.reference));
    return bundle.manifest.conflicts
      .map((item) => item.reference)
      .filter((reference) => !decided.has(reference));
  } catch {
    return [];
  }
}

function classifyFailure(error: unknown, message: string): WorkflowReconciliationInstructionKind {
  if (error instanceof WorkflowReconciliationBundleError) return error.kind;
  if (/another reconciliation operation/i.test(message)) return "locked";
  if (/decisions are incomplete/i.test(message)) return "incomplete";
  if (/no such file|ENOENT|no usable pending|pending bundle/i.test(message)) return "missing";
  if (
    /stale|changed|different reconciliation bundle|unsafe reconciliation|invalid reconciliation bundle/i.test(
      message,
    )
  ) {
    return "stale";
  }
  if (/required|must be|invalid merged|unknown pending conflict/i.test(message)) return "decision";
  if (/database|sqlite|migration|integrity/i.test(message)) return "hard-failure";
  return "decision";
}

function conflictDirectory(root: string, reference: string): string {
  const bundle = loadWorkflowReconciliationBundle(root);
  const conflict = bundle.manifest.conflicts.find((item) => item.reference === reference);
  if (!conflict) throw new Error(`Unknown pending conflict: ${reference}`);
  return path.join(bundle.path, "conflicts", conflict.key);
}

async function run(): Promise<void> {
  const action = process.argv[2];
  const root = recoveryRoot();
  const bundle = loadWorkflowReconciliationBundle(root);
  if (action === "status") {
    const decisions = new Set(bundle.decisions.decisions.map((item) => item.reference));
    console.log(
      JSON.stringify(
        {
          sourceIdentity: bundle.manifest.sourceIdentity,
          conflicts: bundle.manifest.conflicts.map((item) => ({
            reference: item.reference,
            revision: item.revision,
            decided: decisions.has(item.reference),
          })),
          readyToApply: decisions.size === bundle.manifest.conflicts.length,
        },
        null,
        2,
      ),
    );
    const remaining = remainingReferences(root);
    console.log(
      workflowReconciliationAgentInstructions(
        remaining.length === 0 ? "initial" : "incomplete",
        remaining,
      ),
    );
    return;
  }
  if (action === "get") {
    const reference = required("--reference");
    const candidate = required("--candidate");
    if (!/^(previous|current|incoming)$/.test(candidate)) {
      throw new Error("--candidate must be previous, current, or incoming");
    }
    console.log(
      readWorkflowReconciliationBundleCandidate(
        root,
        reference,
        candidate as "previous" | "current" | "incoming",
      ),
    );
    return;
  }
  if (action === "diff") {
    const reference = required("--reference");
    const directory = conflictDirectory(root, reference);
    console.log(
      `Local intent: ${path.join(directory, "previous.json")} -> ${path.join(directory, "current.json")}`,
    );
    console.log(
      `Upstream change: ${path.join(directory, "previous.json")} -> ${path.join(directory, "incoming.json")}`,
    );
    console.log(
      "Read all three files semantically. For a merge, copy incoming as the base and reapply only still-valid local intent.",
    );
    return;
  }
  if (action === "validate") {
    const file = required("--file");
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as ManagedWorkflowState;
    if (state.lifecycle !== "present") throw new Error("Merged state must be present");
    const result = await getWorkflowMutationService().validate(state.content.graph as never);
    if (result.status !== "valid")
      throw new Error(`Invalid merged workflow: ${result.errors.join("; ")}`);
    console.log("Merged workflow is valid");
    return;
  }
  if (action === "choose") {
    const reference = required("--reference");
    const revision = required("--revision");
    const rationale = required("--rationale");
    const selection = required("--selection");
    if (selection !== "current" && selection !== "incoming" && selection !== "merged") {
      throw new Error("--selection must be current, incoming, or merged");
    }
    const merged =
      selection === "merged"
        ? (JSON.parse(fs.readFileSync(required("--file"), "utf8")) as ManagedWorkflowState)
        : undefined;
    const marker = readWorkflowReconciliationBundleApplied(root);
    if (marker) {
      throw new WorkflowReconciliationBundleError(
        "stale",
        "Reconciliation is already committed; choices are immutable",
      );
    }
    const currentBundle = loadWorkflowReconciliationBundle(root);
    if (currentBundle.decisions.decisions.length === currentBundle.manifest.conflicts.length) {
      const entries = readWorkflowCatalogs(getWorkflowsDirs());
      if (isWorkflowReconciliationBundleApplied(root, entries, getSqliteInstance()).applied) {
        throw new WorkflowReconciliationBundleError(
          "stale",
          "Reconciliation is already committed; choices are immutable",
        );
      }
    }
    await withWorkflowReconciliationBundleLock(root, () =>
      chooseWorkflowReconciliationBundleDecision(
        root,
        { reference, revision, rationale, selection },
        merged,
      ),
    );
    console.log(`Recorded ${selection} decision for ${reference}; database unchanged.`);
    const remaining = remainingReferences(root);
    console.log(
      workflowReconciliationAgentInstructions(
        remaining.length === 0 ? "initial" : "incomplete",
        remaining,
      ),
    );
    return;
  }
  if (action === "apply") {
    await withWorkflowReconciliationBundleLock(root, async () => {
      const entries = readWorkflowCatalogs(getWorkflowsDirs());
      const result = await applyWorkflowReconciliationBundle(
        root,
        buildIdentity(),
        entries,
        {
          sqlite: getSqliteInstance(),
          userRepo: new UserRepository(getDatabase()),
          mutationService: getWorkflowMutationService(),
        },
        { source: "self-host-cli" },
      );
      if (result.finalization.warning) console.warn(result.finalization.warning);
      if (result.alreadyApplied) {
        console.log("Reconciliation was already committed; local bundle cleanup completed.");
      }
    });
    console.log("Reconciliation applied atomically. Run: docker compose up -d");
    return;
  }
  throw new Error("Usage: reconcile <status|get|diff|validate|choose|apply> [options]");
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const kind = classifyFailure(error, message);
  let remaining: string[] = [];
  try {
    remaining = remainingReferences(recoveryRoot());
  } catch {
    // Configuration failures have no safe reconciliation directory to inspect.
  }
  console.error(`RECONCILIATION ERROR: ${message}`);
  console.error(workflowReconciliationAgentInstructions(kind, remaining));
  process.exit(1);
});
