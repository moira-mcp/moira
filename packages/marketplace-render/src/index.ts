/**
 * @mcp-moira/marketplace-render — server-renderable public-catalog components + SEO
 * builders for the marketplace. A PURE rendering/data-shaping layer: no HTTP, no DB, no
 * browser-only APIs. The web-backend fetches viewer-annotated data from the marketplace
 * service, maps it to view models, and renders complete SEO-ready HTML strings here.
 *
 * Public API:
 *   - renderExploreToHtml(gallery, viewer, seo) → { html }
 *   - renderDetailToHtml(detail, viewer, seo)   → { html }
 *   - toGalleryView / toDetailView              — service-shape → view-model mappers
 *   - components (ExploreGallery, ListingDetail, ListingCard, badges) for hydration
 *   - SEO builders (head + JSON-LD) and the makeLabels locale adapter
 */

// Render functions (the primary server entry points)
export { renderExploreToHtml } from "./render/renderExplore.js";
export { renderDetailToHtml } from "./render/renderDetail.js";
export { buildDocument, THEME_BOOTSTRAP, type DocumentChrome } from "./render/document.js";

// View-model types + viewer/SEO contexts
export type {
  ViewerAnnotation,
  GalleryCardView,
  GalleryView,
  DetailView,
  ViewerContext,
  SeoContext,
  ExploreFilter,
  RenderResult,
} from "./types.js";

// Service-shape → view-model mappers
export { toGalleryView, toGalleryCardView, toDetailView } from "./mappers.js";

// Components (shared SSR ↔ hydration)
export { ExploreGallery, type ExploreGalleryProps } from "./components/ExploreGallery.js";
export { ListingDetail, type ListingDetailProps } from "./components/ListingDetail.js";
export { ListingCard, type ListingCardProps } from "./components/ListingCard.js";
export { RatingStars, type RatingStarsProps } from "./components/RatingStars.js";
export { VerifiedBadge, type VerifiedBadgeProps } from "./components/VerifiedBadge.js";

// Localization adapter (locale-bound label bundle over @mcp-moira/shared i18n)
export { makeLabels, type Labels } from "./labels.js";

// SEO builders
export { buildHead, type HeadOptions } from "./seo/head.js";
export { escapeHtml, jsonLdSafe, serializeJsonLd } from "./seo/escape.js";
export {
  buildSoftwareApplicationJsonLd,
  buildItemListJsonLd,
  buildBreadcrumbJsonLd,
  type Breadcrumb,
} from "./seo/jsonld.js";
