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

export {
  type OfficialOwnerId,
  OFFICIAL_OWNER_IDS,
  OFFICIAL_BASE_FLOW_SLUGS,
  OFFICIAL_FLOW_CATEGORIES,
  isOfficialOwner,
  officialFlowCategory,
} from "./official.js";

export {
  type PortableFlowSource,
  type PortableFlowFile,
  type ParsedPortableFile,
  PORTABLE_FILE_FORMAT_VERSION,
  PORTABLE_FILE_KIND,
  PortableFileParseError,
  buildPortableFile,
  parsePortableFile,
} from "./portable-file.js";
