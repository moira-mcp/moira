/**
 * The words a person reads for a built-in setting come from the locale files, not from the server.
 *
 * A setting definition carries English label and description text written when it was seeded. The
 * user Settings page looks for `pages.settings.definitions.<key>.{label,description,help}` first and
 * falls back to the server's text, so a built-in setting reads naturally in every language while a
 * setting an extension declares — which the locale files cannot know — still shows its own words.
 */

import type { TFunction } from "i18next";

interface LocalizableDefinition {
  key: string;
  label: string;
  description: string | null;
  help?: string;
}

export function localizeSettingDefinition<D extends LocalizableDefinition>(
  definition: D,
  t: TFunction,
): D {
  const base = `pages.settings.definitions.${definition.key}`;
  const help = t(`${base}.help`, { defaultValue: "" });
  return {
    ...definition,
    label: t(`${base}.label`, { defaultValue: definition.label }),
    description: t(`${base}.description`, { defaultValue: definition.description ?? "" }) || null,
    ...(help ? { help } : {}),
  };
}
