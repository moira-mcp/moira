/**
 * How a workflow definition names a playbook.
 *
 * One form, used everywhere a template is processed: inside a directive, a completion condition, a
 * materialized file, or the default of a registry variable. `{{playbook:review-standard}}` names
 * your own playbook; `{{playbook:@jane/review-standard}}` names somebody else's published one.
 *
 * The pattern lives here rather than in the engine because both sides need it: the engine resolves
 * references while a step is presented, and the editing path checks them before a definition is
 * saved.
 */

/** Matches one playbook reference; group 1 is the optional owner, group 2 the playbook name. */
export const PLAYBOOK_REFERENCE_PATTERN =
  /\{\{playbook:(?:(@?[a-zA-Z0-9_-]+)\/)?([a-z0-9][a-z0-9-]*)\}\}/g;

/** One reference as written in a definition. */
export interface PlaybookReference {
  /** Owner as written, without the separator; absent when the reference means "mine". */
  owner?: string;
  name: string;
  /** The reference as it appears, for messages that quote it back to the author. */
  text: string;
}

/**
 * Every playbook reference in a piece of text, in reading order, without duplicates.
 *
 * A reference written with a leading backslash is escaped — the author means the text, not the
 * playbook — and is skipped, exactly as the template processor skips it at run time. Without that,
 * a document explaining how references are written would itself be read as naming them, and the
 * checks would refuse to save or start it.
 */
export function collectPlaybookReferences(text: string): PlaybookReference[] {
  if (!text || typeof text !== "string") return [];
  const seen = new Set<string>();
  const references: PlaybookReference[] = [];

  for (const match of text.matchAll(PLAYBOOK_REFERENCE_PATTERN)) {
    const [full, owner, name] = match;
    if (isEscaped(text, match.index ?? 0)) continue;
    if (seen.has(full)) continue;
    seen.add(full);
    references.push({
      owner: owner || undefined,
      name,
      text: `${owner ? `${owner}/` : ""}${name}`,
    });
  }

  return references;
}

/**
 * True when the braces at this position are escaped.
 *
 * An odd number of backslashes escapes; an even number is a literal backslash in front of a real
 * reference, which is how the template syntax already reads escapes.
 */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let position = index - 1; position >= 0 && text[position] === "\\"; position -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Every playbook reference anywhere inside a definition, without duplicates.
 *
 * Walking the value rather than its JSON encoding matters for escapes: JSON doubles a backslash, so
 * a reference the author escaped would read as unescaped in the encoded form and the definition
 * would be refused for documenting its own syntax.
 */
export function collectDefinitionReferences(definition: unknown): PlaybookReference[] {
  return collectReferencesDeep(definition);
}

function collectReferencesDeep(value: unknown, into = new Map<string, PlaybookReference>()) {
  if (typeof value === "string") {
    for (const reference of collectPlaybookReferences(value)) {
      if (!into.has(reference.text)) into.set(reference.text, reference);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectReferencesDeep(item, into);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectReferencesDeep(item, into);
  }
  return [...into.values()];
}

/** What a caller needs from the registry to decide whether a reference resolves. */
export interface PlaybookReferenceResolver {
  resolveOwner(owner: string | undefined, userId: string): Promise<string | null>;
  get(userId: string, ownerId: string, slug: string, revision?: number): Promise<unknown | null>;
}

/**
 * The references in a definition that this user cannot resolve right now.
 *
 * One implementation on purpose: editing refuses a definition and starting refuses a run for the
 * same reason, and each surface only writes its own sentence around the answer. Two copies of this
 * walk drifted apart the moment one of them learned about escaped references.
 */
export async function unresolvedPlaybookReferences(
  definition: unknown,
  userId: string,
  registry: PlaybookReferenceResolver,
): Promise<PlaybookReference[]> {
  const references = collectDefinitionReferences(definition);
  const missing: PlaybookReference[] = [];

  for (const reference of references) {
    const ownerId = await registry.resolveOwner(reference.owner, userId);
    const found = ownerId ? await registry.get(userId, ownerId, reference.name) : null;
    if (!found) missing.push(reference);
  }

  return missing;
}
