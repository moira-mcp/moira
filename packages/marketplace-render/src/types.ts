/**
 * View-model types for the marketplace render package.
 *
 * The render layer is a PURE data-shaping/rendering boundary: it never touches the
 * database or HTTP. The web-backend fetches data (gallery / detail) and the viewer's
 * library/ownership annotations from the marketplace service, shapes them into these
 * view models, and passes them in. Every field here is already public to the current
 * viewer — no secrets, no other user's data (see session-sharing design §8).
 */

import type { MarketplaceLocale } from "@mcp-moira/shared/i18n";

/**
 * Per-viewer annotations carried by each gallery/detail item. Produced by the
 * marketplace service's viewer-annotation capability (anonymous → both false).
 */
export interface ViewerAnnotation {
  /** The current viewer already has this flow in their library. */
  inLibrary: boolean;
  /** The current viewer owns (published) this flow. */
  isOwn: boolean;
}

/** A single gallery card view model (one published listing + viewer annotations). */
export interface GalleryCardView extends ViewerAnnotation {
  /** `handle/slug` reference used to build the crawlable detail URL. */
  reference: string;
  title: string;
  summary: string | null;
  /** Raw category enum value (localized at render time). */
  category: string;
  ownerHandle: string | null;
  verified: boolean;
  installCount: number;
  ratingAvg: number;
  ratingCount: number;
}

/** The gallery page view model. */
export interface GalleryView {
  items: GalleryCardView[];
  /** Total published listings matching the query (for the localized header count). */
  total: number;
}

/** The flow-detail view model (one listing + viewer annotations). */
export interface DetailView extends ViewerAnnotation {
  /** `handle/slug` reference (canonical URL + start command). */
  reference: string;
  title: string;
  summary: string | null;
  category: string;
  ownerHandle: string | null;
  verified: boolean;
  installCount: number;
  ratingAvg: number;
  ratingCount: number;
  /** Free-form tags (already parsed from the listing's JSON string). */
  tags: string[];
  /** Number of nodes in the workflow graph (rendered as a localized step count). */
  stepCount: number;
}

/**
 * The current viewer's identity for session-aware rendering. `null` = anonymous
 * (crawler or signed-out visitor): no library/ownership pills, sign-in CTA shown.
 */
export interface ViewerContext {
  userId: string | null;
  handle: string | null;
}

/** SEO context shared by every page (base URL + the locale to localize text into). */
export interface SeoContext {
  /** Absolute origin (scheme+host[:port]) used to build canonical/OG URLs. */
  baseUrl: string;
  /** Locale the page is rendered in (drives counts, enum labels and `<html lang>`). */
  locale: MarketplaceLocale;
}

/** The result of a render call: a complete HTML document string. */
export interface RenderResult {
  html: string;
}
