/**
 * Settings declared by extension manifests, expressed in the shape the rest of Moira already uses.
 *
 * Two facts drive this module. First, an extension's definitions must never be stored: the point of
 * declaring them in the manifest is that throwing away the bundle throws away the declaration, so
 * they are converted on the way out and read again next time. Second, every consumer of the
 * definition list — the settings screen, the admin screen, the MCP tool — must see the same list,
 * because a setting visible in one place and absent in another is worse than one that is missing
 * everywhere.
 */

import * as AjvModule from "ajv";
import type { SettingDefinition } from "../interfaces/data-repository.js";
import type { ExtensionSettingDeclaration } from "./extension-contract.js";
import { DECLARED_SCHEMA_AJV_OPTIONS, declaredSchemaProblem } from "./declared-schema.js";
import { ExtensionRegistry } from "./extension-registry.js";
import { getActiveExtensionRegistry } from "./extension-registry-provider.js";

/** Category an extension's settings appear under on the settings screen. */
export function extensionSettingsCategory(extensionName: string): string {
  return `extension:${extensionName}`;
}

/**
 * A manifest declaration as a `SettingDefinition`.
 *
 * `validation` changes form here: the manifest carries a JSON Schema object, the rest of Moira
 * carries the same schema as a string. Converting in one place keeps the two forms from meeting
 * anywhere else.
 */
export function toSettingDefinition(
  extensionName: string,
  declaration: ExtensionSettingDeclaration,
): SettingDefinition {
  return {
    key: declaration.key,
    type: declaration.type,
    category: extensionSettingsCategory(extensionName),
    label: declaration.label,
    description: declaration.description ?? null,
    defaultValue: declaration.defaultValue ?? null,
    required: declaration.required ?? false,
    validation: declaration.validation ? JSON.stringify(declaration.validation) : null,
    adminOnly: declaration.adminOnly ?? false,
    // Nothing can delete it through the API: it is not stored, and it goes away with the bundle.
    protected: true,
    createdAt: 0,
    updatedAt: 0,
    source: "extension",
    extensionName,
  };
}

/** Definitions contributed by the extensions installed in this process. */
export function extensionSettingDefinitions(
  registry: ExtensionRegistry | null = getActiveExtensionRegistry(),
): SettingDefinition[] {
  if (!registry) return [];
  return registry
    .settingDeclarations()
    .map(({ extensionName, declaration }) => toSettingDefinition(extensionName, declaration));
}

/**
 * Built-in definitions with the extensions' merged in.
 *
 * A declared definition wins over a stored row of the same key. The collision is narrow — reserved
 * namespaces keep an extension out of Moira's own keys, and creating a row for a key an installed
 * extension declares is refused — but it can still be reached by a row created before the extension
 * was installed. When it is, the declaration has to win, because the value paths route by
 * declaration: a definition read from one place and a value read from another would describe a
 * setting nobody can save.
 */
export function mergeSettingDefinitions(
  stored: SettingDefinition[],
  registry: ExtensionRegistry | null = getActiveExtensionRegistry(),
  category?: string,
): SettingDefinition[] {
  const declared = extensionSettingDefinitions(registry).filter(
    (definition) => category === undefined || definition.category === category,
  );
  const declaredKeys = new Set(declared.map((definition) => definition.key));
  return [...stored.filter((definition) => !declaredKeys.has(definition.key)), ...declared];
}

/** The declared definition of one key, or null when no installed extension declares it. */
export function extensionSettingDefinition(
  key: string,
  registry: ExtensionRegistry | null = getActiveExtensionRegistry(),
): SettingDefinition | null {
  return extensionSettingDefinitions(registry).find((definition) => definition.key === key) ?? null;
}

// Ajv ships as CommonJS; the engine constructs it through the module default elsewhere too.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ajv = new (AjvModule as any).default(DECLARED_SCHEMA_AJV_OPTIONS);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const validators = new Map<string, any>();

/**
 * Check a value against the schema its declaration carries, returning a readable list of problems
 * or null when the value matches.
 *
 * The schema is applied in full, not as a handful of familiar keywords: an extension may declare a
 * structural setting, and a check that understood only `type` and `enum` would accept any object
 * whatsoever while appearing to validate it.
 */
export function validateExtensionSettingValue(
  definition: SettingDefinition,
  value: unknown,
): string | null {
  if (!definition.validation) return null;

  // Keyed by the schema itself, not by the setting key: a new version of an extension replaces its
  // declarations under the same keys, so a cache keyed by key would go on applying the schema of
  // the version that has been removed.
  const cacheKey = `${definition.key}\u0000${definition.validation}`;
  let validate = validators.get(cacheKey);
  if (!validate) {
    let schema: unknown;
    try {
      schema = JSON.parse(definition.validation);
    } catch (error) {
      // A schema that cannot be parsed is a defect of the manifest, and skipping the check would
      // turn it into a setting that only looks validated.
      return `declared validation schema is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    // A manifest whose schema does not compile is refused when the bundle is loaded, so reaching
    // this line means the declaration arrived by some other path — a registry snapshot from another
    // Moira, a build with a different Ajv. It stays a named refusal rather than an exception, for
    // the same reason as the unparsable case above: from outside, an exception here is Moira
    // breaking, not the bundle being wrong.
    const problem = declaredSchemaProblem(schema);
    if (problem) return `declared validation schema is not a usable JSON Schema: ${problem}`;

    try {
      validate = ajv.compile(schema);
    } catch (error) {
      // Nothing known can reach this line — the manifest check compiles with the same options, and
      // a schema that compiles there compiles here. It stays a named refusal rather than an
      // exception because the alternative, from outside, is Moira breaking on a value an
      // administrator typed.
      return `declared validation schema could not be compiled: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    validators.set(cacheKey, validate);
  }

  if (validate(value)) return null;
  const errors = (validate.errors ?? []) as Array<{
    instancePath?: string;
    message?: string;
    params?: Record<string, unknown>;
  }>;
  return errors
    .map((issue) => {
      // The offending property is carried in `params` for keywords that do not put it in the path
      // (`additionalProperties`, `required`); without it the message names only the parent object,
      // which is exactly the case an administrator needs help with.
      const named =
        issue.params && typeof issue.params.additionalProperty === "string"
          ? ` '${issue.params.additionalProperty}'`
          : issue.params && typeof issue.params.missingProperty === "string"
            ? ` '${issue.params.missingProperty}'`
            : "";
      return `${issue.instancePath || "/"} ${issue.message ?? "is invalid"}${named}`;
    })
    .join("; ");
}
