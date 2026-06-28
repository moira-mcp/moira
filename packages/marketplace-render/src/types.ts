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
  /** Marketplace listing id — the target of the adopt (install) action. */
  listingId: string;
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
  /** Marketplace listing id — the target of the adopt (install) action. */
  listingId: string;
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
  /**
   * Path portion of the current page (e.g. `/explore`, `/w/handle/slug`). Used by the
   * page chrome to build the language-switch links (same path, different `?lang`) and to
   * mark the active language. Defaults to `/explore` when omitted.
   */
  currentPath?: string;
  /**
   * Base path the SPA is mounted under (`""` for self-host root, `/app` for the hosted
   * deploy). Used to build same-origin SPA links from the chrome (e.g. sign-in `/login`).
   * Defaults to `""`.
   */
  appPrefix?: string;
}

/**
 * The active gallery filter, threaded SSR → hydration so the storefront's filter chips
 * render their active state identically on both sides. Currently the single "Official"
 * toggle (owned by a system/official account); `official:false` is the "All" view.
 */
export interface ExploreFilter {
  official: boolean;
  /** The COMMUNITY partition (non-official). Mutually exclusive with `official`. */
  community?: boolean;
  /** The active free-text search, threaded so the no-results state and chip links know it. */
  search?: string;
}

/**
 * Per-partition gallery counts for the storefront filter chips, respecting the active
 * search but NOT the official/community selection. `official` + `community` = `all`, so
 * the chips show a meaningful, non-redundant partition (and the correct total/filtered
 * count). Anonymous and signed-in viewers see the same facets (public data).
 */
export interface GalleryFacets {
  all: number;
  official: number;
  community: number;
}

/** The result of a render call: a complete HTML document string. */
export interface RenderResult {
  html: string;
}
