import { afterEach, describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWorkflowReconciliationArtifactFromBundle,
  cleanupRetiredWorkflowReconciliationBundles,
  chooseWorkflowReconciliationBundleDecision,
  loadWorkflowReconciliationBundle,
  publishWorkflowReconciliationBundle,
  readWorkflowReconciliationBundleConflicts,
  withWorkflowReconciliationBundleLock,
  finalizeWorkflowReconciliationBundle,
  markWorkflowReconciliationBundleApplied,
  readWorkflowReconciliationBundleApplied,
  workflowReconciliationConflictRevision,
  workflowReconciliationAgentInstructions,
  type CatalogEntry,
  type ManagedWorkflowState,
  type WorkflowReconciliationConflictRecord,
} from "@mcp-moira/shared";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function state(directive: string): ManagedWorkflowState {
  return {
    lifecycle: "present",
    content: {
      visibility: "public",
      graph: {
        metadata: { name: directive, version: "1.0.0", description: directive },
        nodes: [
          { id: "start", type: "start", connections: { default: "step" } },
          {
            id: "step",
            type: "agent-directive",
            directive,
            completionCondition: "done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      },
    },
  };
}

function fixture(slug: string): {
  entry: CatalogEntry;
  conflict: WorkflowReconciliationConflictRecord;
} {
  const previous = state(`${slug}-previous`);
  const current = state(`${slug}-current`);
  const incoming = state(`${slug}-incoming`);
  const base = {
    owner: "system-moira",
    slug,
    currentWorkflowId: `${slug}-id`,
    currentWorkflowSlug: slug,
    previousManagedSlug: null,
    classification: "conflict",
    previous,
    current,
    incoming,
    instruction: "inspect semantically",
  };
  const conflict: WorkflowReconciliationConflictRecord = {
    ...base,
    revision: workflowReconciliationConflictRevision(base),
    candidateRefs: { previous: null, current: "", incoming: "" },
    recoveryLocation: "",
  };
  return {
    conflict,
    entry: {
      id: `${slug}-id`,
      owner: "system-moira",
      slug,
      visibility: "public",
      isSystemOwner: true,
      filePath: `memory://${slug}`,
      graph: incoming.content.graph,
    },
  };
}

describe("workflow reconciliation local bundle", () => {
  test("cleans only safe retired bundles and preserves live pending state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moira-reconciliation-retired-startup-"));
    roots.push(root);
    const pending = path.join(root, "pending");
    const retiredA = path.join(root, ".applied-00000000-0000-4000-8000-000000000001");
    const retiredB = path.join(root, ".applied-00000000-0000-4000-8000-000000000002");
    fs.mkdirSync(pending);
    fs.writeFileSync(path.join(pending, "live"), "live");
    fs.mkdirSync(retiredA);
    fs.mkdirSync(retiredB);
    fs.writeFileSync(path.join(retiredA, "candidate.json"), "sensitive");
    fs.writeFileSync(path.join(retiredB, "candidate.json"), "sensitive");

    expect(cleanupRetiredWorkflowReconciliationBundles(root)).toBe(2);
    expect(fs.readFileSync(path.join(pending, "live"), "utf8")).toBe("live");
    expect(fs.existsSync(retiredA)).toBe(false);
    expect(fs.existsSync(retiredB)).toBe(false);
  });

  test("fails closed for unsafe or partially removable retired bundles", () => {
    const unsafeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "moira-reconciliation-retired-unsafe-"),
    );
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "moira-reconciliation-retired-outside-"));
    roots.push(unsafeRoot, outside);
    fs.writeFileSync(path.join(outside, "kept"), "outside");
    fs.symlinkSync(outside, path.join(unsafeRoot, ".applied-00000000-0000-4000-8000-000000000001"));
    expect(() => cleanupRetiredWorkflowReconciliationBundles(unsafeRoot)).toThrow(
      "Unsafe retired reconciliation bundle",
    );
    expect(fs.readFileSync(path.join(outside, "kept"), "utf8")).toBe("outside");

    const partialRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "moira-reconciliation-retired-partial-"),
    );
    roots.push(partialRoot);
    const first = path.join(partialRoot, ".applied-00000000-0000-4000-8000-000000000001");
    const second = path.join(partialRoot, ".applied-00000000-0000-4000-8000-000000000002");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    let calls = 0;
    expect(() =>
      cleanupRetiredWorkflowReconciliationBundles(partialRoot, {
        remove: (target, options) => {
          calls += 1;
          if (calls === 2) throw new Error("cleanup interrupted");
          fs.rmSync(target, options);
        },
      }),
    ).toThrow("cleanup interrupted");
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(true);
  });

  test("does not expose or retain a partial bundle when final publication is interrupted", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moira-reconciliation-publish-fault-"));
    roots.push(root);
    const item = fixture("flow-publish-fault");

    expect(() =>
      publishWorkflowReconciliationBundle(root, "image-sha", [item.entry], [item.conflict], {
        rename: () => {
          throw new Error("publication interrupted");
        },
      }),
    ).toThrow("publication interrupted");
    expect(fs.existsSync(path.join(root, "pending"))).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(() => loadWorkflowReconciliationBundle(root)).toThrow("No usable pending bundle");
  });

  test("publishes complete candidates and accumulates decisions without a database", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moira-reconciliation-bundle-"));
    roots.push(root);
    const fixtures = [fixture("flow-a"), fixture("flow-b")];
    const manifest = publishWorkflowReconciliationBundle(
      root,
      "image-sha",
      fixtures.map((item) => item.entry),
      fixtures.map((item) => item.conflict),
    );
    expect(manifest.conflicts).toHaveLength(2);
    expect(readWorkflowReconciliationBundleConflicts(root).map((item) => item.revision)).toEqual(
      fixtures.map((item) => item.conflict.revision),
    );

    chooseWorkflowReconciliationBundleDecision(root, {
      reference: "system-moira/flow-a",
      revision: fixtures[0].conflict.revision,
      selection: "current",
      rationale: "Keep the instance-specific behavior.",
    });
    expect(loadWorkflowReconciliationBundle(root).decisions.decisions).toHaveLength(1);
    expect(() =>
      buildWorkflowReconciliationArtifactFromBundle(
        root,
        fixtures.map((item) => item.entry),
      ),
    ).toThrow("Reconciliation decisions are incomplete");
    expect(fs.existsSync(path.join(root, "pending"))).toBe(true);

    chooseWorkflowReconciliationBundleDecision(
      root,
      {
        reference: "system-moira/flow-b",
        revision: fixtures[1].conflict.revision,
        selection: "merged",
        rationale: "Use incoming and retain the local approval rule.",
      },
      state("flow-b-merged"),
    );
    const artifact = buildWorkflowReconciliationArtifactFromBundle(
      root,
      fixtures.map((item) => item.entry),
    );
    expect(artifact.decisions).toMatchObject([
      { reference: "system-moira/flow-a", selection: "current" },
      { reference: "system-moira/flow-b", selection: "current", merged: state("flow-b-merged") },
    ]);
  });

  test("preserves the previous decisions manifest when a replacement is invalid", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moira-reconciliation-choice-"));
    roots.push(root);
    const item = fixture("flow-choice");
    publishWorkflowReconciliationBundle(root, "image-sha", [item.entry], [item.conflict]);
    chooseWorkflowReconciliationBundleDecision(root, {
      reference: "system-moira/flow-choice",
      revision: item.conflict.revision,
      selection: "incoming",
      rationale: "Incoming supersedes the experiment.",
    });
    const before = fs.readFileSync(path.join(root, "pending", "decisions.json"), "utf8");
    expect(() =>
      chooseWorkflowReconciliationBundleDecision(root, {
        reference: "system-moira/flow-choice",
        revision: "0".repeat(64),
        selection: "current",
        rationale: "stale",
      }),
    ).toThrow("Stale or invalid reconciliation choice");
    expect(fs.readFileSync(path.join(root, "pending", "decisions.json"), "utf8")).toBe(before);
  });

  test("serializes operations with a local exclusive lock", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moira-reconciliation-lock-"));
    roots.push(root);
    await withWorkflowReconciliationBundleLock(root, async () => {
      await expect(withWorkflowReconciliationBundleLock(root, () => undefined)).rejects.toThrow(
        "Another reconciliation operation is active",
      );
    });
    await expect(withWorkflowReconciliationBundleLock(root, () => "released")).resolves.toBe(
      "released",
    );
  });

  test("rejects a symlinked pending bundle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moira-reconciliation-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "moira-reconciliation-outside-"));
    roots.push(root, outside);
    fs.symlinkSync(outside, path.join(root, "pending"));
    expect(() => loadWorkflowReconciliationBundle(root)).toThrow("Unsafe pending bundle");
  });

  test("rejects candidate bytes changed after bundle publication", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moira-reconciliation-tamper-"));
    roots.push(root);
    const item = fixture("flow-tamper");
    const manifest = publishWorkflowReconciliationBundle(
      root,
      "image-sha",
      [item.entry],
      [item.conflict],
    );
    fs.writeFileSync(
      path.join(root, "pending", "conflicts", manifest.conflicts[0].key, "current.json"),
      JSON.stringify(state("tampered")),
    );
    expect(() => readWorkflowReconciliationBundleConflicts(root)).toThrow(
      "Reconciliation file changed",
    );
  });

  test("refuses candidate symlinks and oversized files before reading bytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moira-reconciliation-read-safety-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "moira-reconciliation-secret-"));
    roots.push(root, outside);
    const item = fixture("flow-read-safety");
    const manifest = publishWorkflowReconciliationBundle(
      root,
      "image-sha",
      [item.entry],
      [item.conflict],
    );
    const currentPath = path.join(
      root,
      "pending",
      "conflicts",
      manifest.conflicts[0].key,
      "current.json",
    );
    fs.writeFileSync(path.join(outside, "secret.json"), JSON.stringify(state("secret")));
    fs.rmSync(currentPath);
    fs.symlinkSync(path.join(outside, "secret.json"), currentPath);
    expect(() => readWorkflowReconciliationBundleConflicts(root)).toThrow(
      "Unsafe reconciliation file",
    );

    fs.rmSync(currentPath);
    const fd = fs.openSync(currentPath, "w");
    fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1);
    fs.closeSync(fd);
    expect(() => readWorkflowReconciliationBundleConflicts(root)).toThrow(
      "Unsafe reconciliation file",
    );
  });

  test("reports post-commit bundle retirement and cleanup states without false rollback", () => {
    const pendingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moira-reconciliation-retire-"));
    roots.push(pendingRoot);
    const pendingItem = fixture("flow-pending-cleanup");
    publishWorkflowReconciliationBundle(
      pendingRoot,
      "image-sha",
      [pendingItem.entry],
      [pendingItem.conflict],
    );
    markWorkflowReconciliationBundleApplied(pendingRoot, "a".repeat(64));
    const pending = finalizeWorkflowReconciliationBundle(pendingRoot, {
      rename: () => {
        throw new Error("rename fault");
      },
    });
    expect(pending).toMatchObject({
      state: "pending",
      warning: expect.stringContaining("committed"),
    });
    expect(fs.existsSync(path.join(pendingRoot, "pending"))).toBe(true);
    expect(readWorkflowReconciliationBundleApplied(pendingRoot)).toMatchObject({
      artifactDigest: "a".repeat(64),
    });
    expect(finalizeWorkflowReconciliationBundle(pendingRoot)).toEqual({ state: "removed" });
    expect(fs.existsSync(path.join(pendingRoot, "pending"))).toBe(false);

    const retiredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moira-reconciliation-cleanup-"));
    roots.push(retiredRoot);
    const retiredItem = fixture("flow-retired-cleanup");
    publishWorkflowReconciliationBundle(
      retiredRoot,
      "image-sha",
      [retiredItem.entry],
      [retiredItem.conflict],
    );
    const retired = finalizeWorkflowReconciliationBundle(retiredRoot, {
      remove: () => {
        throw new Error("remove fault");
      },
    });
    expect(retired).toMatchObject({
      state: "retired",
      warning: expect.stringContaining("committed"),
    });
    expect(fs.existsSync(path.join(retiredRoot, "pending"))).toBe(false);
    expect(fs.readdirSync(retiredRoot).some((name) => name.startsWith(".applied-"))).toBe(true);
  });

  test("renders branch-specific executable recovery instructions", () => {
    const incomplete = workflowReconciliationAgentInstructions("incomplete", [
      "system-moira/flow-a",
    ]);
    expect(incomplete).toContain("Apply is prohibited");
    expect(incomplete).toContain("system-moira/flow-a");
    expect(incomplete).toContain("choose --reference");

    const stale = workflowReconciliationAgentInstructions("stale");
    expect(stale).toContain("Regenerate evidence with: docker compose up -d");
    expect(stale).not.toContain("npm run reconcile -- apply");
    expect(stale).not.toContain("choose --reference");

    const hard = workflowReconciliationAgentInstructions("hard-failure");
    expect(hard).toContain("not a workflow reconciliation conflict");
    expect(hard).not.toContain("choose --reference");

    const locked = workflowReconciliationAgentInstructions("locked");
    expect(locked).toContain("Do not remove the lock");
    expect(locked).not.toContain("npm run reconcile -- apply");

    const missing = workflowReconciliationAgentInstructions("missing");
    expect(missing).toContain("Create fresh evidence with: docker compose up -d");
    expect(missing).not.toContain("choose --reference");
  });
});
