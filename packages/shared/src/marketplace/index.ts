/**
 * Marketplace domain module (shared).
 *
 * Cross-cutting marketplace primitives used by the engine, web-backend, and
 * mcp-server: the fixed category set, status/source/kind enums, and small
 * helpers. Persistence lives in `database/`; behavior lives in `services/`.
 */

export {
  type MarketplaceCategory,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_IDS,
  DEFAULT_MARKETPLACE_CATEGORY,
  isValidMarketplaceCategory,
  normalizeMarketplaceCategory,
} from "./constants.js";
