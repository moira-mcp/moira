/**
 * Mappers from the marketplace SERVICE shapes (viewer-annotated gallery items / detail)
 * to the render package's view models. This is the seam between the data layer
 * (`@mcp-moira/shared` marketplace service) and the pure render layer: the web-backend
 * fetches annotated data and calls these to obtain `GalleryView` / `DetailView` for the
 * render functions.
 *
 * The mappers only read public, viewer-safe fields (title/summary/category/counters +
 * the `inLibrary`/`isOwn` annotations) — they never carry secrets or other users' data.
 */

import type { AnnotatedGalleryItem, AnnotatedListingDetail } from "@mcp-moira/shared";
import type { GalleryView, GalleryCardView, DetailView } from "./types.js";

/** Build a `handle/slug` reference, falling back to the bare slug when no handle. */
function referenceOf(ownerHandle: string | null, slug: string): string {
  return ownerHandle ? `${ownerHandle}/${slug}` : slug;
}

/** Parse a listing's JSON-string `tags` column into a string array (tolerant). */
function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Map one annotated gallery item to a card view model. */
export function toGalleryCardView(item: AnnotatedGalleryItem): GalleryCardView {
  return {
    reference: referenceOf(item.ownerHandle, item.slug),
    title: item.title,
    summary: item.summary,
    category: item.category,
    ownerHandle: item.ownerHandle,
    verified: item.verified,
    installCount: item.installCount,
    ratingAvg: item.ratingAvg,
    ratingCount: item.ratingCount,
    inLibrary: item.inLibrary,
    isOwn: item.isOwn,
  };
}

/** Map an annotated gallery page to the gallery view model. */
export function toGalleryView(page: {
  items: AnnotatedGalleryItem[];
  total: number;
}): GalleryView {
  return {
    items: page.items.map(toGalleryCardView),
    total: page.total,
  };
}

/** Map an annotated listing detail to the detail view model. */
export function toDetailView(detail: AnnotatedListingDetail): DetailView {
  const listing = detail.listing;
  const stepCount = Array.isArray(detail.workflow.nodes) ? detail.workflow.nodes.length : 0;
  return {
    reference: detail.startRef,
    title: listing.title,
    summary: listing.summary,
    category: listing.category,
    ownerHandle: detail.ownerHandle,
    verified: listing.verified,
    installCount: listing.installCount,
    ratingAvg: listing.ratingAvg,
    ratingCount: listing.ratingCount,
    tags: parseTags(listing.tags),
    stepCount,
    inLibrary: detail.inLibrary,
    isOwn: detail.isOwn,
  };
}
