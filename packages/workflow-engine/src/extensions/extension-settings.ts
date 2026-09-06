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

import type { SettingDefinition } from "../interfaces/data-repository.js";
import type { ExtensionSettingDeclaration } from "./extension-contract.js";
import { ExtensionRegistry } from "./extension-registry.js";
import { getActiveExtensionRegistry } from "./extension-registry-provider.js";
export {
  prepareExtensionSettingValue,
  validateExtensionSettingValue,
} from "./extension-setting-values.js";

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
