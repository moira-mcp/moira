/**
 * Restore JSON Schema constraints on workflow-global variables that were lost when the variable
 * model migrated to `variableRegistry` (commit 51f7db0d). Before that migration a global-to-be was
 * declared as a node-output with a full JSON Schema (enum/items/pattern/properties/min*); the
 * migration collapsed registry entries to {type, description}, dropping every other keyword.
 *
 * Two tiers:
 *  - Tier A (deterministic, default): for a flow whose slug matches a pre-migration version, restore
 *    each variable's lost keywords from its old node-output schema. Restoration ONLY strengthens —
 *    it never removes a description and never weakens a keyword the current entry already has, and
 *    it never narrows a value below what the flow legitimately produced.
 *
 *    A single output name can appear in several nodes of one flow with DIFFERENT schemas (e.g. two
 *    gates each accepting a different enum set, all feeding one global). Picking one node's schema
 *    would re-install a constraint that rejects values the other node legitimately produces — the
 *    exact gate-rejects-valid-value defect #565 fixes. So per (slug, name) we MERGE all observed
 *    schemas safely: union enums, loosest numeric/length bounds, and skip-and-report any name whose
 *    nodes disagree on `type` or on a structural keyword (items/properties) — those go to the report
 *    for deliberate human restoration rather than a guess.
 *
 *    A global mutated at runtime by an expression node (e.g. a counter `x = x + 1`) is special: its
 *    only schema-bearing pre-migration outputs were reset nodes that emit the floor value, so the
 *    history describes the reset, not the running value. Restoring a value-bounding keyword
 *    (enum/minimum/maximum) there would pin the counter to its reset value — the #565 defect again.
 *    So for any name that is an expression-assignment target in the flow, value-bounding keywords
 *    are dropped from the source before restoration (structural/type/length keywords still apply).
 *  - Tier B (heuristic, --apply-heuristics): for a flow with no historical version, infer a gate
 *    variable's enum from the literal values its condition nodes compare it against. Report-only by
 *    default (observed values are a lower bound, so each inference needs human review).
 *
 * Idempotent. Use --dry to preview without writing.
 *
 * Run: npx tsx scripts/remigrate-registry-schemas.ts [--dry] [--apply-heuristics]
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const DRY = process.argv.includes("--dry");
const APPLY_HEURISTICS = process.argv.includes("--apply-heuristics");
const OLD_REF = "51f7db0d~1";
const FLOWS_DIR = path.resolve("workflows/production/flows");
const OLD_ROOTS = ["workflows/production/public", "workflows/production/private"];

// JSON Schema keywords that constrain a value beyond bare {type, description}.
const CONSTRAINT_KEYWORDS = [
  "enum",
  "items",
  "properties",
  "required",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "additionalProperties",
];

// Which JSON Schema `type`(s) each constraint keyword is meaningful for. `enum` applies to any type,
// so it is intentionally absent — it is gated only by the entry-level type-match check (see
// strengthen). A keyword copied onto a mismatched type compiles under non-strict AJV but rejects
// every value (e.g. string `items` on a number), which is a silent corruption we must prevent.
const KEYWORD_TYPES: Record<string, string[]> = {
  items: ["array"],
  minItems: ["array"],
  maxItems: ["array"],
  properties: ["object"],
  required: ["object"],
  additionalProperties: ["object"],
  pattern: ["string"],
  format: ["string"],
  minLength: ["string"],
  maxLength: ["string"],
  minimum: ["number", "integer"],
  maximum: ["number", "integer"],
};

type Json = Record<string, unknown>;

function readJson(p: string): Json {
  return JSON.parse(fs.readFileSync(p, "utf8")) as Json;
}

function gitShow(ref: string, file: string): string | null {
  try {
    return execSync(`git show ${ref}:${file}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Result of merging all pre-migration schemas observed for one (slug, name): either a single safe
 * source schema, or a conflict that must be restored by a human rather than guessed. */
export interface MergedSchema {
  schema?: Json; // safe merged source (undefined when conflicting)
  conflict?: string; // human-readable reason the name was skipped
}

/** Merge every pre-migration schema observed for one output name within a flow into ONE safe source
 * schema. CORE PRINCIPLE: absence of a constraint = the loosest possible constraint — a node that
 * OMITS a keyword permitted ALL values, so a keyword survives the merge only if EVERY observation
 * declares it; otherwise it is dropped (unbounded wins). Safety rules:
 *  - `type` must agree across all observations; a mismatch is a conflict (skip + report).
 *  - `enum` → UNION of all observed sets, but ONLY when every observation declares an enum; if any
 *    omits it, no enum is restored (the open node accepted any value).
 *  - `minimum`/`minLength`/`minItems` → the LOOSEST (smallest) value, and `maximum`/`maxLength`/
 *    `maxItems` → the LOOSEST (largest), but ONLY when every observation declares that bound; if any
 *    omits it, the bound is dropped. A surviving enum already fully specifies the allowed values, so
 *    numeric/length bounds are not co-emitted alongside an enum.
 *  - structural keywords are RECONCILED across writers (not skipped on disagreement), only when every
 *    observation declares them (an omission means that writer was open → drop):
 *      `items` → recursively merged element schema (an irreconcilable element, e.g. type mismatch,
 *        drops `items` = any element); `properties` → UNION of keys, each shared key reconciled
 *        recursively; `required` → INTERSECTION (required only if every writer requires it);
 *        `pattern`/`format`/`additionalProperties` → kept only if all declare and deep-equal, else
 *        dropped. Only a top-level `type` disagreement remains a hard conflict (skip + report).
 */
export function mergeOldSchemas(schemas: Json[]): MergedSchema {
  if (schemas.length === 0) return {};
  if (schemas.length === 1) return { schema: schemas[0] };

  const types = new Set(schemas.map((s) => s.type).filter((t) => t !== undefined));
  if (types.size > 1) {
    return { conflict: `type disagreement: ${[...types].join(" vs ")}` };
  }

  const merged: Json = { type: [...types][0] ?? schemas[0].type };

  // CORE PRINCIPLE: absence of a constraint = the loosest possible constraint. A node that OMITS a
  // keyword permitted ALL values for it, so a keyword may survive the merge ONLY if EVERY
  // observation declares it. If any observation omits it, the safe merge is unbounded → drop the
  // keyword. (Otherwise a declared bound/enum from one node would reject values an open-bounded
  // sibling legitimately produced — the #565 gate-rejects-valid-value defect.)
  const n = schemas.length;

  // enum: emit the UNION only when every observation declares an enum; one open node ⇒ no enum.
  if (schemas.every((s) => Array.isArray(s.enum))) {
    const enumValues = new Set<unknown>();
    for (const s of schemas) for (const v of s.enum as unknown[]) enumValues.add(v);
    merged.enum = [...enumValues].sort();
  }

  // numeric / length / item bounds: emit the LOOSEST only when every observation declares the bound.
  const allDeclaredBound = (key: string, kind: "min" | "max"): void => {
    const vals = schemas.map((s) => s[key]).filter((v): v is number => typeof v === "number");
    if (vals.length === n) merged[key] = kind === "min" ? Math.min(...vals) : Math.max(...vals);
  };
  // A surviving enum already fully specifies the allowed values; co-emitting numeric/length bounds
  // is at best redundant and at worst contradicts the enum — so only restore bounds when no enum.
  if (!("enum" in merged)) {
    allDeclaredBound("minimum", "min");
    allDeclaredBound("minLength", "min");
    allDeclaredBound("minItems", "min");
    allDeclaredBound("maximum", "max");
    allDeclaredBound("maxLength", "max");
    allDeclaredBound("maxItems", "max");
  }

  // `items` (array element schema): reconcile recursively across all observations that declare it.
  // Only when EVERY observation declares items (else the open node accepted any element → drop).
  const itemsDeclared = schemas.filter((s) => "items" in s).map((s) => s.items);
  if (itemsDeclared.length === n) {
    const objItems = itemsDeclared.filter(
      (it): it is Json => !!it && typeof it === "object" && !Array.isArray(it),
    );
    if (objItems.length === itemsDeclared.length) {
      const m = mergeOldSchemas(objItems);
      if (m.schema) merged.items = m.schema;
      // a conflict inside items (e.g. type disagreement) → drop items (loosest: any element)
    }
  }

  // `properties` (object): UNION across all observations that declare it; a shared key's schema is
  // reconciled recursively. Only when EVERY observation declares properties (else open → drop).
  const propsDeclared = schemas.filter((s) => "properties" in s).map((s) => s.properties);
  if (propsDeclared.length === n) {
    const objProps = propsDeclared.filter(
      (p): p is Record<string, Json> => !!p && typeof p === "object" && !Array.isArray(p),
    );
    if (objProps.length === propsDeclared.length) {
      const mergedProps: Record<string, Json> = {};
      const allKeys = new Set<string>();
      for (const p of objProps) for (const k of Object.keys(p)) allKeys.add(k);
      for (const k of allKeys) {
        const variants = objProps.filter((p) => k in p).map((p) => p[k]);
        // A key declared by only some writers is still a valid property of the union; reconcile the
        // variants that do declare it.
        const m = mergeOldSchemas(variants.filter((v): v is Json => !!v && typeof v === "object"));
        mergedProps[k] = m.schema ?? variants[0];
      }
      merged.properties = mergedProps;
    }
  }

  // `required` (object): INTERSECTION across observations that declare properties — a key is
  // required only if EVERY writer requires it (a key one writer omits cannot be globally required).
  const reqLists = schemas.map((s) =>
    Array.isArray(s.required) ? (s.required as string[]) : null,
  );
  if (reqLists.every((r) => r !== null) && reqLists.length === n) {
    const sets = reqLists as string[][];
    const inter = sets[0].filter((k) => sets.every((r) => r.includes(k)));
    if (inter.length) merged.required = inter;
  }

  // pattern / format / additionalProperties: keep only when EVERY observation declares it AND they
  // deep-equal; any omission or disagreement → drop (the loosest, never a hard conflict).
  for (const key of ["pattern", "format", "additionalProperties"]) {
    const declared = schemas.filter((s) => key in s).map((s) => s[key]);
    if (declared.length !== n) continue;
    const first = JSON.stringify(declared[0]);
    if (declared.every((d) => JSON.stringify(d) === first)) merged[key] = declared[0];
  }

  return { schema: merged };
}

/** Build slug -> { name -> MergedSchema } from the pre-migration node-output declarations. */
function buildOldSchemasBySlug(): {
  merged: Map<string, Map<string, MergedSchema>>;
  conflicts: string[];
} {
  const collected = new Map<string, Map<string, Json[]>>();
  const conflicts: string[] = [];
  let oldFiles: string[] = [];
  try {
    oldFiles = execSync(`git ls-tree -r ${OLD_REF} --name-only`, { encoding: "utf8" })
      .split("\n")
      .filter((f) => OLD_ROOTS.some((r) => f.startsWith(r)) && f.endsWith(".json"));
  } catch {
    return { merged: new Map(), conflicts };
  }
  for (const file of oldFiles) {
    const raw = gitShow(OLD_REF, file);
    if (!raw) continue;
    let d: Json;
    try {
      d = JSON.parse(raw) as Json;
    } catch {
      continue;
    }
    const slug = (d.slug as string) || path.basename(file, ".json");
    const perName = collected.get(slug) ?? new Map<string, Json[]>();
    const nodes = (d.nodes as Json[]) || [];
    for (const node of nodes) {
      // OLD_REF is pre-migration (51f7db0d~1): node outputs lived in flat inputSchema.properties.
      // If OLD_REF ever moves to a commit using the globalInputs array model, source extraction
      // here would silently find nothing and must be revisited.
      const inputSchema = node.inputSchema as Json | undefined;
      const props = inputSchema?.properties as Record<string, Json> | undefined;
      if (!props) continue;
      for (const [name, schema] of Object.entries(props)) {
        if (!schema || typeof schema !== "object") continue;
        const list = perName.get(name) ?? [];
        list.push(schema);
        perName.set(name, list);
      }
    }
    collected.set(slug, perName);
  }

  const merged = new Map<string, Map<string, MergedSchema>>();
  for (const [slug, perName] of collected) {
    const out = new Map<string, MergedSchema>();
    for (const [name, list] of perName) {
      const m = mergeOldSchemas(list);
      out.set(name, m);
      if (m.conflict)
        conflicts.push(`  [conflict] ${slug}: ${name} — ${m.conflict} (skipped, restore manually)`);
    }
    merged.set(slug, out);
  }
  return { merged, conflicts };
}

/** Strengthen `target` with constraint keywords from `source` it does not already have. Returns the
 * keywords actually added. Never removes anything; never overwrites an existing keyword. A keyword is
 * only copied when it is meaningful for the target's `type` — a type-specific keyword on a mismatched
 * type compiles under non-strict AJV but rejects every value, so we refuse it. When source and target
 * both declare a `type` and they differ, nothing is copied at all. */
export function strengthen(target: Json, source: Json): string[] {
  const added: string[] = [];
  const targetType = target.type as string | undefined;
  if (targetType !== undefined && source.type !== undefined && source.type !== targetType) {
    return added;
  }
  for (const k of CONSTRAINT_KEYWORDS) {
    if (!(k in source) || k in target) continue;
    const allowedTypes = KEYWORD_TYPES[k];
    if (allowedTypes && targetType !== undefined && !allowedTypes.includes(targetType)) continue;
    target[k] = source[k];
    added.push(k);
  }
  return added;
}

/** Tier B: collect literal values a variable is compared against in condition nodes. */
export function inferGateEnums(flow: Json): Map<string, string[]> {
  const observed = new Map<string, Set<string>>();
  const walk = (cond: Json | undefined): void => {
    if (!cond || typeof cond !== "object") return;
    const left = cond.left as Json | undefined;
    const right = cond.right;
    // Only equality against a non-empty literal signals a gate value. `neq ""` is a presence
    // check (e.g. a path), not an enum, so it is excluded.
    if (
      cond.operator === "eq" &&
      left &&
      typeof left === "object" &&
      typeof left.contextPath === "string" &&
      typeof right === "string" &&
      right !== ""
    ) {
      const cp = left.contextPath;
      // bare-name (global) only — a node-id.name local is owned by its node's properties.
      if (!cp.includes(".")) {
        const set = observed.get(cp) ?? new Set<string>();
        set.add(right);
        observed.set(cp, set);
      }
    }
    for (const sub of (cond.conditions as Json[]) || []) walk(sub);
    // Do NOT recurse into `not`'s condition: an `eq` under `not` names a value that must NOT match,
    // so collecting its literal would suggest a DISALLOWED value as an allowed enum member.
    if (cond.condition && cond.operator !== "not") walk(cond.condition as Json);
  };
  for (const node of (flow.nodes as Json[]) || []) {
    if (node.type === "condition") walk(node.condition as Json);
  }
  const result = new Map<string, string[]>();
  for (const [name, set] of observed) {
    if (set.size > 0) result.set(name, [...set].sort());
  }
  return result;
}

// Value-bounding keywords that pin or cap a value. A global mutated at runtime by an expression
// node (e.g. a counter `x = x + 1`) must NOT carry any of these restored from reset-node outputs:
// reset nodes only ever emit the floor value (0/1), so their schema describes the reset, not the
// global's true value space. Restoring them would pin the counter (the #565 defect class).
const VALUE_BOUNDING_KEYWORDS = ["enum", "minimum", "maximum"];

/** Collect the bare-name globals that an expression node assigns to. An expression `x = x + 1`
 * names `x` as its assignment target (left of the first `=`). Such a global is mutated at runtime
 * outside schema validation, so value-bounding keywords must not be restored for it. */
export function collectExpressionTargets(flow: Json): Set<string> {
  const targets = new Set<string>();
  for (const node of (flow.nodes as Json[]) || []) {
    if (node.type !== "expression") continue;
    for (const expr of (node.expressions as string[]) || []) {
      if (typeof expr !== "string") continue;
      const lhs = expr.split("=")[0]?.trim();
      // bare-name global only — a node-id.name target is owned by its node's local properties.
      if (lhs && !lhs.includes(".") && /^[A-Za-z_][A-Za-z0-9_]*$/.test(lhs)) {
        targets.add(lhs);
      }
    }
  }
  return targets;
}

export function bumpMinor(version: string): string | null {
  const parts = version.split(".");
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
  parts[1] = String(Number(parts[1]) + 1);
  parts[2] = "0";
  return parts.join(".");
}

/** Resolve a name's safe merged source schema for restoration, or undefined when there is none or
 * the observed schemas conflicted (conflicts are reported separately, not auto-applied). */
function safeSource(old: Map<string, MergedSchema> | undefined, name: string): Json | undefined {
  const m = old?.get(name);
  return m?.schema;
}

function main(): void {
  const { merged: oldBySlug, conflicts } = buildOldSchemasBySlug();
  const files = fs.readdirSync(FLOWS_DIR).filter((f) => f.endsWith(".json"));

  let tierAChanged = 0;
  let tierBSuggested = 0;
  let tierBApplied = 0;
  const report: string[] = [];

  for (const file of files) {
    const full = path.join(FLOWS_DIR, file);
    const flow = readJson(full);
    const slug = flow.slug as string;
    const registry = (flow.variableRegistry as Record<string, Json>) || {};
    const nodes = (flow.nodes as Json[]) || [];
    const old = oldBySlug.get(slug);

    const changedVars: string[] = [];
    let isTierB = false;

    if (old) {
      // Tier A — restore from history into registry entries and node-local properties. Each name's
      // source is the safe merge of all its pre-migration observations; conflicting names have no
      // source and are skipped (reported globally below).
      const exprTargets = collectExpressionTargets(flow);
      // Two cases drop value-bounding keywords (enum/minimum/maximum) from the restoration source —
      // both are the #565 counter-pinning defect class, where the pre-migration source was a
      // reset-node output describing only the floor value, never the running value:
      //  1. the global is mutated by an expression node (a counter `x = x + 1`); or
      //  2. the global (or the source) is numeric. A numeric enum in this catalog is always a
      //     reset artifact ({enum:[0]}/{enum:[1]}) — genuine numeric enums do not occur, and a
      //     single-value numeric enum pins a counter the agent legitimately grows. Numeric globals
      //     keep structural/type keywords but never inherit a restored enum/min/max.
      // Structural/type/length keywords are unaffected; string gates keep their enum.
      const restoreSource = (src: Json, name: string, targetType: unknown): Json => {
        const numeric =
          targetType === "number" ||
          targetType === "integer" ||
          src.type === "number" ||
          src.type === "integer";
        if (!exprTargets.has(name) && !numeric) return src;
        const cleaned: Json = {};
        for (const [k, v] of Object.entries(src)) {
          if (!VALUE_BOUNDING_KEYWORDS.includes(k)) cleaned[k] = v;
        }
        return cleaned;
      };
      for (const [name, entry] of Object.entries(registry)) {
        const src = safeSource(old, name);
        if (src && entry && typeof entry === "object") {
          const added = strengthen(entry, restoreSource(src, name, entry.type));
          if (added.length) changedVars.push(`registry.${name} +[${added.join(",")}]`);
        }
      }
      for (const node of nodes) {
        const props = (node.inputSchema as Json | undefined)?.properties as
          | Record<string, Json>
          | undefined;
        if (!props) continue;
        for (const [name, schema] of Object.entries(props)) {
          const src = safeSource(old, name);
          if (src && schema && typeof schema === "object") {
            const added = strengthen(schema, restoreSource(src, name, schema.type));
            if (added.length)
              changedVars.push(`${node.id as string}.${name} +[${added.join(",")}]`);
          }
        }
      }
    } else {
      // Tier B — heuristic gate-enum inference (report, or apply with flag).
      isTierB = true;
      const inferred = inferGateEnums(flow);
      for (const [name, values] of inferred) {
        const entry = registry[name];
        if (entry && typeof entry === "object" && entry.type === "string" && !("enum" in entry)) {
          if (APPLY_HEURISTICS) {
            entry.enum = values;
            changedVars.push(`registry.${name} +[enum(heuristic)=${values.join("|")}]`);
          } else {
            tierBSuggested++;
            report.push(`  [heuristic] ${slug}: ${name} could be enum [${values.join(", ")}]`);
          }
        }
      }
    }

    if (changedVars.length) {
      const oldVersion = (flow.metadata as Json).version as string;
      const nv = bumpMinor(oldVersion);
      if (nv) {
        (flow.metadata as Json).version = nv;
      } else {
        report.push(
          `  [warn] ${slug}: version "${oldVersion}" is not semver — content changed but version NOT bumped`,
        );
      }
      report.push(
        `${isTierB ? "[B]" : "[A]"} ${slug} ${oldVersion}->${nv}: ${changedVars.join("; ")}`,
      );
      if (isTierB) tierBApplied++;
      else tierAChanged++;
      if (!DRY) {
        fs.writeFileSync(full, JSON.stringify(flow, null, 2) + "\n");
      }
    }
  }

  if (conflicts.length) {
    report.push("");
    report.push(
      `Tier A conflicts (same name, incompatible schemas across nodes — restore manually):`,
    );
    report.push(...conflicts);
  }

  console.log(report.join("\n"));
  console.log("");
  console.log(`${DRY ? "[DRY] " : ""}Tier A flows changed: ${tierAChanged}`);
  console.log(
    `${DRY ? "[DRY] " : ""}Tier A names skipped (conflicting schemas): ${conflicts.length}`,
  );
  console.log(
    APPLY_HEURISTICS
      ? `${DRY ? "[DRY] " : ""}Tier B flows changed (heuristics applied): ${tierBApplied}`
      : `Tier B suggestions (report-only, use --apply-heuristics): ${tierBSuggested}`,
  );
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && process.argv[1].endsWith("remigrate-registry-schemas.ts")) {
  main();
}
