/**
 * Shared i18n primitives: a framework-free pluralization/declension utility and the
 * canonical marketplace label data (countable nouns + enum labels) reused by the
 * server-side render layer and mirrored by the SPA.
 */

export {
  type PluralCategory,
  type PluralForms,
  pluralCategory,
  selectForm,
  formatCount,
} from "./plural.js";

export {
  type MarketplaceLocale,
  type MarketplaceCountNoun,
  type MarketplaceEnumKind,
  toMarketplaceLocale,
  MARKETPLACE_COUNTABLE_NOUNS,
  MARKETPLACE_ENUM_LABELS,
  formatMarketplaceCount,
  marketplaceEnumLabel,
} from "./marketplace-labels.js";
