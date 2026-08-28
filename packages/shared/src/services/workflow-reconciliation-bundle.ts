import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import type { CatalogEntry } from "./workflow-catalog.js";
import {
  createWorkflowReconciliationStagedArtifactFromConflicts,
  applyWorkflowReconciliationStagedArtifact,
  workflowCatalogDigest,
  workflowReconciliationConflictSetDigest,
  type WorkflowReconciliationDecisionInput,
  type WorkflowReconciliationStagedArtifact,
  type CatalogLoadDeps,
} from "./workflow-catalog-loader.js";
import {
  WorkflowReconciliationRepository,
  managedWorkflowStateDigest,
  parseManagedWorkflowState,
  type ManagedWorkflowState,
  type WorkflowReconciliationConflictRecord,
} from "../database/repositories/workflow-reconciliation-repository.js";
import { getSqliteInstance } from "../database/connection.js";

const BUNDLE_VERSION = 1;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_RATIONALE_LENGTH = 2_000;

export type WorkflowReconciliationBundleErrorKind =
  "stale" | "missing" | "locked" | "incomplete" | "decision";

export class WorkflowReconciliationBundleError extends Error {
  constructor(
    public readonly kind: WorkflowReconciliationBundleErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowReconciliationBundleError";
  }
}

function bundleError(kind: WorkflowReconciliationBundleErrorKind, message: string): never {
  throw new WorkflowReconciliationBundleError(kind, message);
}

interface BundleConflictMeta {
  reference: string;
  key: string;
  revision: string;
  classification: string;
  currentWorkflowId: string | null;
  currentWorkflowSlug: string | null;
  previousManagedSlug: string | null;
  instruction: string;
  candidateDigests: { previous: string; current: string; incoming: string };
}

export interface WorkflowReconciliationBundleManifest {
  version: 1;
  sourceIdentity: string;
  catalogDigest: string;
  conflictSetDigest: string;
  createdAt: string;
  conflicts: BundleConflictMeta[];
}

export interface WorkflowReconciliationBundleChoice {
  reference: string;
  revision: string;
  selection: "current" | "incoming" | "merged";
  rationale: string;
  mergedFile?: string;
  mergedDigest?: string;
}

interface DecisionsManifest {
  version: 1;
  decisions: WorkflowReconciliationBundleChoice[];
}

export interface WorkflowReconciliationAppliedMarker {
  version: 1;
  artifactDigest: string;
  committedAt: string;
}

const pendingPath = (root: string): string => path.join(root, "pending");
const RETIRED_BUNDLE_PATTERN =
  /^\.applied-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function ensureSafeDirectory(directory: string): void {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return bundleError("stale", `Unsafe reconciliation directory: ${directory}`);
  }
  chmodSync(directory, 0o700);
}

function writeDurableFile(filePath: string, content: string): void {
  const fd = openSync(filePath, "wx", 0o600);
  try {
    writeSync(fd, content, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeJson(filePath: string, value: unknown): void {
  writeDurableFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readFileOnce(filePath: string, expectedDigest?: string): Buffer {
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return bundleError("stale", `Unsafe reconciliation file: ${filePath}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES) {
      return bundleError("stale", `Unsafe reconciliation file: ${filePath}`);
    }
    const content = readFileSync(fd);
    if (expectedDigest && sha256(content) !== expectedDigest) {
      return bundleError("stale", `Reconciliation file changed: ${filePath}`);
    }
    return content;
  } finally {
    closeSync(fd);
  }
}

function parseJsonContent(content: Buffer | string, context: string): unknown {
  try {
    return JSON.parse(content.toString()) as unknown;
  } catch {
    return bundleError("stale", `Malformed reconciliation JSON: ${context}`);
  }
}

function readJson(filePath: string): unknown {
  return parseJsonContent(readFileOnce(filePath), filePath);
}

function readVerifiedFile(filePath: string, expectedDigest: string): Buffer {
  return readFileOnce(filePath, expectedDigest);
}

function parseCapturedState(value: unknown, context: string): ManagedWorkflowState {
  try {
    return parseManagedWorkflowState(value, context);
  } catch {
    return bundleError("stale", `Malformed captured reconciliation state: ${context}`);
  }
}

function atomicReplaceJson(filePath: string, value: unknown): void {
  const temporary = `${filePath}.next-${randomUUID()}`;
  try {
    writeJson(temporary, value);
    renameSync(temporary, filePath);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function conflictKey(reference: string): string {
  return sha256(reference).slice(0, 24);
}

export async function withWorkflowReconciliationBundleLock<T>(
  root: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  ensureSafeDirectory(root);
  const lockPath = path.join(root, "operation.lock");
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch {
    throw new WorkflowReconciliationBundleError(
      "locked",
      "Another reconciliation operation is active",
    );
  }
  try {
    return await operation();
  } finally {
    closeSync(fd);
    rmSync(lockPath);
  }
}

function validateManifest(value: unknown): WorkflowReconciliationBundleManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return bundleError("stale", "Invalid reconciliation bundle manifest");
  }
  const manifest = value as WorkflowReconciliationBundleManifest;
  if (
    manifest.version !== BUNDLE_VERSION ||
    !manifest.sourceIdentity ||
    !/^[a-f0-9]{64}$/.test(manifest.catalogDigest) ||
    !/^[a-f0-9]{64}$/.test(manifest.conflictSetDigest) ||
    !Array.isArray(manifest.conflicts) ||
    manifest.conflicts.length === 0
  ) {
    return bundleError("stale", "Invalid reconciliation bundle manifest");
  }
  const references = new Set<string>();
  for (const conflict of manifest.conflicts) {
    if (
      !conflict.reference ||
      !/^[a-f0-9]{24}$/.test(conflict.key) ||
      conflict.key !== conflictKey(conflict.reference) ||
      !/^[a-f0-9]{64}$/.test(conflict.revision) ||
      !conflict.candidateDigests ||
      Object.values(conflict.candidateDigests).some((digest) => !/^[a-f0-9]{64}$/.test(digest)) ||
      references.has(conflict.reference)
    ) {
      return bundleError("stale", "Invalid reconciliation bundle conflict metadata");
    }
    references.add(conflict.reference);
  }
  return manifest;
}

function validateDecisions(value: unknown): DecisionsManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return bundleError("stale", "Invalid reconciliation decisions manifest");
  }
  const manifest = value as DecisionsManifest;
  if (manifest.version !== BUNDLE_VERSION || !Array.isArray(manifest.decisions)) {
    return bundleError("stale", "Invalid reconciliation decisions manifest");
  }
  const references = new Set<string>();
  for (const decision of manifest.decisions) {
    if (
      !decision.reference ||
      !/^[a-f0-9]{64}$/.test(decision.revision) ||
      !["current", "incoming", "merged"].includes(decision.selection) ||
      !decision.rationale?.trim() ||
      decision.rationale.length > MAX_RATIONALE_LENGTH ||
      references.has(decision.reference)
    ) {
      return bundleError("stale", "Invalid reconciliation decision");
    }
    if (
      decision.selection === "merged" &&
      (!decision.mergedFile ||
        !/^[a-f0-9]{24}\.json$/.test(decision.mergedFile) ||
        !decision.mergedDigest?.match(/^[a-f0-9]{64}$/))
    ) {
      return bundleError("stale", "Invalid merged reconciliation decision");
    }
    references.add(decision.reference);
  }
  return manifest;
}

export function publishWorkflowReconciliationBundle(
  root: string,
  sourceIdentity: string,
  entries: CatalogEntry[],
  conflicts: WorkflowReconciliationConflictRecord[],
  operations: { rename?: typeof renameSync } = {},
): WorkflowReconciliationBundleManifest {
  if (!sourceIdentity.trim() || conflicts.length === 0) {
    return bundleError("decision", "Reconciliation bundle requires source identity and conflicts");
  }
  ensureSafeDirectory(root);
  const manifest: WorkflowReconciliationBundleManifest = {
    version: 1,
    sourceIdentity,
    catalogDigest: workflowCatalogDigest(entries),
    conflictSetDigest: workflowReconciliationConflictSetDigest(conflicts),
    createdAt: new Date().toISOString(),
    conflicts: conflicts.map((conflict) => {
      const serialize = (state: ManagedWorkflowState | null) =>
        `${JSON.stringify(state, null, 2)}\n`;
      return {
        reference: `${conflict.owner}/${conflict.slug}`,
        key: conflictKey(`${conflict.owner}/${conflict.slug}`),
        revision: conflict.revision,
        classification: conflict.classification,
        currentWorkflowId: conflict.currentWorkflowId,
        currentWorkflowSlug: conflict.currentWorkflowSlug,
        previousManagedSlug: conflict.previousManagedSlug,
        instruction: conflict.instruction,
        candidateDigests: {
          previous: sha256(serialize(conflict.previous)),
          current: sha256(serialize(conflict.current)),
          incoming: sha256(serialize(conflict.incoming)),
        },
      };
    }),
  };
  const pending = pendingPath(root);
  if (existsSync(pending)) {
    const existing = loadWorkflowReconciliationBundle(root).manifest;
    if (
      existing.sourceIdentity === manifest.sourceIdentity &&
      existing.catalogDigest === manifest.catalogDigest &&
      existing.conflictSetDigest === manifest.conflictSetDigest
    ) {
      return existing;
    }
    return bundleError("stale", "A different reconciliation bundle is already pending");
  }
  const staging = path.join(root, `.pending-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    mkdirSync(path.join(staging, "conflicts"), { mode: 0o700 });
    mkdirSync(path.join(staging, "merged"), { mode: 0o700 });
    let totalBytes = 0;
    for (const [index, conflict] of conflicts.entries()) {
      const meta = manifest.conflicts[index];
      const directory = path.join(staging, "conflicts", meta.key);
      mkdirSync(directory, { mode: 0o700 });
      for (const [candidate, state] of [
        ["previous", conflict.previous],
        ["current", conflict.current],
        ["incoming", conflict.incoming],
      ] as const) {
        const content = `${JSON.stringify(state, null, 2)}\n`;
        totalBytes += Buffer.byteLength(content);
        if (totalBytes > MAX_BUNDLE_BYTES) {
          return bundleError("stale", "Reconciliation bundle is too large");
        }
        writeDurableFile(path.join(directory, `${candidate}.json`), content);
      }
    }
    writeJson(path.join(staging, "manifest.json"), manifest);
    writeJson(path.join(staging, "decisions.json"), { version: 1, decisions: [] });
    (operations.rename ?? renameSync)(staging, pending);
    return manifest;
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true });
  }
}

export function loadWorkflowReconciliationBundle(root: string): {
  path: string;
  manifest: WorkflowReconciliationBundleManifest;
  decisions: DecisionsManifest;
} {
  ensureSafeDirectory(root);
  const pending = pendingPath(root);
  if (!existsSync(pending)) return bundleError("missing", "No usable pending bundle exists");
  const stat = lstatSync(pending);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return bundleError("stale", "Unsafe pending bundle");
  }
  return {
    path: pending,
    manifest: validateManifest(readJson(path.join(pending, "manifest.json"))),
    decisions: validateDecisions(readJson(path.join(pending, "decisions.json"))),
  };
}

export function readWorkflowReconciliationBundleConflicts(
  root: string,
): WorkflowReconciliationConflictRecord[] {
  const bundle = loadWorkflowReconciliationBundle(root);
  return bundle.manifest.conflicts.map((meta) => {
    const readCandidate = (candidate: "previous" | "current" | "incoming"): unknown => {
      return parseJsonContent(
        readWorkflowReconciliationBundleCandidate(root, meta.reference, candidate),
        `${meta.reference} ${candidate}`,
      );
    };
    const previous = readCandidate("previous");
    const current = parseCapturedState(
      readCandidate("current"),
      `${meta.reference} current candidate`,
    );
    const incoming = parseCapturedState(
      readCandidate("incoming"),
      `${meta.reference} incoming candidate`,
    );
    return {
      owner: meta.reference.slice(0, meta.reference.indexOf("/")),
      slug: meta.reference.slice(meta.reference.indexOf("/") + 1),
      currentWorkflowId: meta.currentWorkflowId,
      currentWorkflowSlug: meta.currentWorkflowSlug,
      previousManagedSlug: meta.previousManagedSlug,
      classification: meta.classification,
      previous:
        previous === null
          ? null
          : parseCapturedState(previous, `${meta.reference} previous candidate`),
      current,
      incoming,
      instruction: meta.instruction,
      revision: meta.revision,
      candidateRefs: { previous: null, current: "", incoming: "" },
      recoveryLocation: bundle.path,
    };
  });
}

export function readWorkflowReconciliationBundleCandidate(
  root: string,
  reference: string,
  candidate: "previous" | "current" | "incoming",
): string {
  const bundle = loadWorkflowReconciliationBundle(root);
  const meta = bundle.manifest.conflicts.find((item) => item.reference === reference);
  if (!meta) return bundleError("decision", `Unknown pending conflict: ${reference}`);
  const filePath = path.join(bundle.path, "conflicts", meta.key, `${candidate}.json`);
  const content = readVerifiedFile(filePath, meta.candidateDigests[candidate]);
  const parsed = parseJsonContent(content, `${reference} ${candidate}`);
  if (!(candidate === "previous" && parsed === null)) {
    parseCapturedState(parsed, `${reference} ${candidate} candidate`);
  }
  return content.toString("utf8");
}

export function chooseWorkflowReconciliationBundleDecision(
  root: string,
  choice: Omit<WorkflowReconciliationBundleChoice, "mergedFile" | "mergedDigest">,
  merged?: ManagedWorkflowState,
): void {
  const bundle = loadWorkflowReconciliationBundle(root);
  const conflict = bundle.manifest.conflicts.find((item) => item.reference === choice.reference);
  if (
    !conflict ||
    conflict.revision !== choice.revision ||
    (choice.selection === "merged") !== !!merged
  ) {
    return bundleError("stale", "Stale or invalid reconciliation choice");
  }
  const decision: WorkflowReconciliationBundleChoice = { ...choice };
  if (merged) {
    const state = parseManagedWorkflowState(merged, `${choice.reference} merged candidate`);
    const content = `${JSON.stringify(state, null, 2)}\n`;
    const fileName = `${conflict.key}.json`;
    atomicReplaceJson(path.join(bundle.path, "merged", fileName), state);
    decision.mergedFile = fileName;
    decision.mergedDigest = sha256(content);
  }
  const decisions = bundle.decisions.decisions.filter(
    (item) => item.reference !== decision.reference,
  );
  decisions.push(decision);
  decisions.sort((left, right) => left.reference.localeCompare(right.reference));
  atomicReplaceJson(path.join(bundle.path, "decisions.json"), { version: 1, decisions });
}

export function buildWorkflowReconciliationArtifactFromBundle(
  root: string,
  entries: CatalogEntry[],
): WorkflowReconciliationStagedArtifact {
  const bundle = loadWorkflowReconciliationBundle(root);
  if (bundle.manifest.catalogDigest !== workflowCatalogDigest(entries)) {
    return bundleError("stale", "Pending reconciliation catalog is stale");
  }
  if (bundle.decisions.decisions.length !== bundle.manifest.conflicts.length) {
    return bundleError("incomplete", "Reconciliation decisions are incomplete");
  }
  const conflicts = readWorkflowReconciliationBundleConflicts(root);
  const decisions: WorkflowReconciliationDecisionInput[] = bundle.decisions.decisions.map(
    (decision) => {
      let merged: ManagedWorkflowState | undefined;
      if (decision.selection === "merged") {
        const filePath = path.join(bundle.path, "merged", decision.mergedFile!);
        const content = readVerifiedFile(filePath, decision.mergedDigest!);
        merged = parseManagedWorkflowState(
          parseJsonContent(content, "merged candidate"),
          "merged candidate",
        );
      }
      return {
        reference: decision.reference,
        revision: decision.revision,
        selection: decision.selection === "merged" ? "current" : decision.selection,
        rationale: decision.rationale,
        merged,
      };
    },
  );
  return createWorkflowReconciliationStagedArtifactFromConflicts(
    conflicts,
    bundle.manifest.sourceIdentity,
    entries,
    decisions,
  );
}

export function finalizeWorkflowReconciliationBundle(
  root: string,
  operations: {
    rename?: typeof renameSync;
    remove?: typeof rmSync;
  } = {},
): { state: "removed" | "retired" | "pending"; warning?: string } {
  const pending = pendingPath(root);
  if (!existsSync(pending)) return { state: "removed" };
  const retired = path.join(root, `.applied-${randomUUID()}`);
  try {
    const stat = lstatSync(pending);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe pending bundle");
    (operations.rename ?? renameSync)(pending, retired);
  } catch (error) {
    return {
      state: "pending",
      warning: `Database reconciliation committed; pending bundle retirement failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    (operations.remove ?? rmSync)(retired, { recursive: true });
    return { state: "removed" };
  } catch (error) {
    return {
      state: "retired",
      warning: `Database reconciliation committed; retired bundle cleanup remains at ${retired}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function cleanupRetiredWorkflowReconciliationBundles(
  root: string,
  operations: { remove?: typeof rmSync } = {},
): number {
  if (!existsSync(root)) return 0;
  ensureSafeDirectory(root);
  let removed = 0;
  for (const name of readdirSync(root)
    .filter((entry) => entry.startsWith(".applied-"))
    .sort()) {
    const retired = path.join(root, name);
    const stat = lstatSync(retired);
    if (!RETIRED_BUNDLE_PATTERN.test(name) || !stat.isDirectory() || stat.isSymbolicLink()) {
      return bundleError("stale", `Unsafe retired reconciliation bundle: ${retired}`);
    }
    (operations.remove ?? rmSync)(retired, { recursive: true });
    if (existsSync(retired)) {
      return bundleError("stale", `Retired reconciliation bundle was not removed: ${retired}`);
    }
    removed += 1;
  }
  return removed;
}

export function markWorkflowReconciliationBundleApplied(
  root: string,
  artifactDigest: string,
): WorkflowReconciliationAppliedMarker {
  if (!/^[a-f0-9]{64}$/.test(artifactDigest)) {
    return bundleError("stale", "Invalid applied reconciliation artifact digest");
  }
  const bundle = loadWorkflowReconciliationBundle(root);
  const marker: WorkflowReconciliationAppliedMarker = {
    version: 1,
    artifactDigest,
    committedAt: new Date().toISOString(),
  };
  atomicReplaceJson(path.join(bundle.path, "applied.json"), marker);
  return marker;
}

export function readWorkflowReconciliationBundleApplied(
  root: string,
): WorkflowReconciliationAppliedMarker | null {
  const bundle = loadWorkflowReconciliationBundle(root);
  const markerPath = path.join(bundle.path, "applied.json");
  if (!existsSync(markerPath)) return null;
  const value = readJson(markerPath) as Partial<WorkflowReconciliationAppliedMarker>;
  if (
    value.version !== 1 ||
    typeof value.artifactDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.artifactDigest) ||
    typeof value.committedAt !== "string"
  ) {
    return bundleError("stale", "Invalid applied reconciliation marker");
  }
  return value as WorkflowReconciliationAppliedMarker;
}

export function isWorkflowReconciliationBundleApplied(
  root: string,
  entries: CatalogEntry[],
  sqlite: Database.Database,
): { applied: boolean; artifact: WorkflowReconciliationStagedArtifact } {
  const artifact = buildWorkflowReconciliationArtifactFromBundle(root, entries);
  const conflicts = new Map(
    readWorkflowReconciliationBundleConflicts(root).map((conflict) => [
      `${conflict.owner}/${conflict.slug}`,
      conflict,
    ]),
  );
  const repository = new WorkflowReconciliationRepository(sqlite);
  const baselines = repository.listBaselines();
  for (const decision of artifact.decisions) {
    const conflict = conflicts.get(decision.reference);
    if (!conflict) return { applied: false, artifact };
    const selected =
      decision.merged ?? (decision.selection === "incoming" ? conflict.incoming : conflict.current);
    const resolution = repository.findResolution(conflict.owner, conflict.slug);
    const workflow = repository.findWorkflow(conflict.owner, [conflict.slug]);
    const current: ManagedWorkflowState = workflow
      ? {
          lifecycle: workflow.deleted ? "deleted" : "present",
          content: { graph: workflow.graph, visibility: workflow.visibility },
        }
      : { lifecycle: "absent" };
    const baseline = baselines.find(
      (item) => item.owner === conflict.owner && item.slug === conflict.slug,
    );
    if (
      !resolution ||
      resolution.incomingDigest !== managedWorkflowStateDigest(conflict.incoming) ||
      resolution.resultDigest !== managedWorkflowStateDigest(selected) ||
      resolution.rationale !== decision.rationale ||
      resolution.merged !== (decision.merged !== undefined) ||
      managedWorkflowStateDigest(current) !== managedWorkflowStateDigest(selected) ||
      !baseline ||
      managedWorkflowStateDigest(baseline.state) !== managedWorkflowStateDigest(conflict.incoming)
    ) {
      return { applied: false, artifact };
    }
  }
  return { applied: true, artifact };
}

export async function applyWorkflowReconciliationBundle(
  root: string,
  currentSourceIdentity: string,
  entries: CatalogEntry[],
  deps: CatalogLoadDeps,
  resolutionContext: { actorId?: string; source?: string } = {},
  finalizationOperations: Parameters<typeof finalizeWorkflowReconciliationBundle>[1] = {},
): Promise<{
  alreadyApplied: boolean;
  finalization: ReturnType<typeof finalizeWorkflowReconciliationBundle>;
}> {
  const appliedState = isWorkflowReconciliationBundleApplied(
    root,
    entries,
    deps.sqlite ?? getSqliteInstance(),
  );
  const committed = readWorkflowReconciliationBundleApplied(root);
  if (committed && committed.artifactDigest !== appliedState.artifact.artifactDigest) {
    return bundleError("stale", "Applied marker does not match the pending artifact");
  }
  if (committed && !appliedState.applied) {
    return bundleError("stale", "Applied marker is not backed by committed database state");
  }
  if (appliedState.applied) {
    if (!committed) {
      markWorkflowReconciliationBundleApplied(root, appliedState.artifact.artifactDigest);
    }
    return {
      alreadyApplied: true,
      finalization: finalizeWorkflowReconciliationBundle(root, finalizationOperations),
    };
  }
  const artifact = appliedState.artifact;
  await applyWorkflowReconciliationStagedArtifact(
    artifact,
    currentSourceIdentity,
    entries,
    deps,
    resolutionContext,
  );
  markWorkflowReconciliationBundleApplied(root, artifact.artifactDigest);
  return {
    alreadyApplied: false,
    finalization: finalizeWorkflowReconciliationBundle(root, finalizationOperations),
  };
}

export type WorkflowReconciliationInstructionKind =
  "initial" | "incomplete" | "decision" | "stale" | "locked" | "missing" | "hard-failure";

export function workflowReconciliationAgentInstructions(
  kind: WorkflowReconciliationInstructionKind = "initial",
  remainingReferences: string[] = [],
): string {
  const common = [
    "=== AGENT INSTRUCTIONS ===",
    "Do not use --force and do not blindly retry an unchanged command.",
  ];
  if (kind === "hard-failure") {
    return [
      ...common,
      "This is not a workflow reconciliation conflict. Do not run choose or apply.",
      "Inspect the startup error and verified backup, correct the configuration/image problem, then run: docker compose up -d",
      "=== END AGENT INSTRUCTIONS ===",
    ].join("\n");
  }
  if (kind === "stale") {
    return [
      ...common,
      "The pending evidence is stale or unsafe. The database was not changed by this failed command.",
      "Do not run choose or apply against this bundle. Regenerate evidence with: docker compose up -d",
      "Then follow the new bundle revision printed by startup.",
      "=== END AGENT INSTRUCTIONS ===",
    ].join("\n");
  }
  if (kind === "locked") {
    return [
      ...common,
      "Another reconciliation operation owns the local lock. Do not remove the lock or start apply.",
      "After that operation finishes, inspect current state with: docker compose run --rm moira npm run reconcile -- status",
      "=== END AGENT INSTRUCTIONS ===",
    ].join("\n");
  }
  if (kind === "missing") {
    return [
      ...common,
      "No usable pending bundle exists. Do not run choose or apply.",
      "Create fresh evidence with: docker compose up -d",
      "=== END AGENT INSTRUCTIONS ===",
    ].join("\n");
  }
  const inspect = [
    "User workflow changes are preserved; choose changes only the local decisions manifest.",
    "Run: docker compose run --rm moira npm run reconcile -- status",
    "For each reference run: docker compose run --rm moira npm run reconcile -- diff --reference owner/slug",
    "Read candidates with: docker compose run --rm moira npm run reconcile -- get --reference owner/slug --candidate previous|current|incoming",
    "Use incoming as the merge base and previous→current to identify local intent. Previous is evidence and cannot be selected.",
    "Validate a merged state with: docker compose run --rm moira npm run reconcile -- validate --file /app/data/.moira-reconciliation/pending/merged/FILE.json",
    "Record each decision with: docker compose run --rm moira npm run reconcile -- choose --reference owner/slug --selection current|incoming|merged --revision REVISION --rationale TEXT [--file MERGED.json]",
  ];
  if (kind === "decision") {
    return [
      ...common,
      ...inspect,
      "Correct the invalid or missing decision with the exact revision-bound choose command. Do not run apply yet.",
      "=== END AGENT INSTRUCTIONS ===",
    ].join("\n");
  }
  if (kind === "incomplete") {
    return [
      ...common,
      ...inspect,
      `Apply is prohibited until choices exist for: ${remainingReferences.join(", ") || "the remaining conflicts"}`,
      "Run the missing choose commands, then status. Only when readyToApply=true run: docker compose run --rm moira npm run reconcile -- apply",
      "=== END AGENT INSTRUCTIONS ===",
    ].join("\n");
  }
  return [
    ...common,
    ...inspect,
    "Do not run apply until status reports readyToApply=true.",
    "When complete run: docker compose run --rm moira npm run reconcile -- apply",
    "After successful apply run: docker compose up -d",
    "=== END AGENT INSTRUCTIONS ===",
  ].join("\n");
}
