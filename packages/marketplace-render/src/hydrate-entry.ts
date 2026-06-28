/**
 * Hydration-safe barrel — the SUBSET of the render package the browser hydration bundle
 * needs: the presentational components, the locale-bound label adapter, and the
 * view-model / context types. Deliberately excludes the service-shape mappers
 * (`toGalleryView`/`toDetailView`) and the server render functions so the client bundle
 * (and the web-frontend's `tsc` program) never pulls in the marketplace SERVICE / auth /
 * validation modules — those are a server concern and only reach this package through
 * `mappers.ts`, which the browser never imports.
 *
 * The web-backend keeps importing the full API from the package root (`./index.ts`); the
 * web-frontend hydration entry imports from here (`@mcp-moira/marketplace-render/hydrate`).
 */

export { ExploreGallery, type ExploreGalleryProps } from "./components/ExploreGallery.js";
export { ListingDetail, type ListingDetailProps } from "./components/ListingDetail.js";
export { ListingCard, type ListingCardProps } from "./components/ListingCard.js";
export { RatingStars, type RatingStarsProps } from "./components/RatingStars.js";
export { VerifiedBadge, type VerifiedBadgeProps } from "./components/VerifiedBadge.js";
export { makeLabels, type Labels } from "./labels.js";
export type {
  GalleryView,
  GalleryCardView,
  DetailView,
  ViewerContext,
  SeoContext,
  ExploreFilter,
  GalleryFacets,
  ViewerAnnotation,
} from "./types.js";
