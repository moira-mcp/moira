/**
 * ExploreGallery — the public catalog grid: a localized header with the total count
 * and a semantic `<ul>` of {@link ListingCard}s (or an empty-state message). Wrapped in
 * a `<main>` so the document is crawlable without JS. Pure + SSR-safe.
 */

import React from "react";
import type { GalleryView, ViewerContext, ExploreFilter } from "../types.js";
import type { Labels } from "../labels.js";
import { ListingCard } from "./ListingCard.js";
import { exploreHref } from "../links.js";

export interface ExploreGalleryProps {
  gallery: GalleryView;
  labels: Labels;
  viewer: ViewerContext | null;
  baseUrl: string;
  /** The active filter, for the chips' active state. Defaults to the "All" view. */
  filter?: ExploreFilter;
  /** Adopt side-effect (install + reload) threaded to each card; hydration only. */
  onAdopt?: (listingId: string) => void | Promise<void>;
}

export function ExploreGallery({
  gallery,
  labels,
  viewer,
  baseUrl,
  filter,
  onAdopt,
}: ExploreGalleryProps): React.ReactElement {
  const official = filter?.official ?? false;
  return (
    <main className="mp-explore" data-mp="explore">
      <header className="mp-header">
        <h1>{labels.chrome.exploreTitle}</h1>
        <p className="mp-subtitle">{labels.chrome.exploreSubtitle}</p>
        <p className="mp-total" data-mp="total">
          {labels.published(gallery.total)}
        </p>
        {/* Filter chips are LINKS (crawlable + SSR-navigable): each carries the matching
            `?official`/`?lang` query so the server re-renders the scoped, in-language
            gallery. The active chip is driven by the threaded filter, not client state. */}
        <nav className="mp-chips" data-mp="filter-chips" aria-label={labels.chrome.filterAll}>
          <a
            className={official ? "mp-chip" : "mp-chip mp-chip-active"}
            href={exploreHref(baseUrl, labels.locale, false)}
            data-mp="chip-all"
            aria-pressed={official ? "false" : "true"}
          >
            {labels.chrome.filterAll}
          </a>
          <a
            className={official ? "mp-chip mp-chip-active" : "mp-chip"}
            href={exploreHref(baseUrl, labels.locale, true)}
            data-mp="chip-official"
            aria-pressed={official ? "true" : "false"}
          >
            {labels.chrome.filterOfficial}
          </a>
        </nav>
      </header>
      {gallery.items.length > 0 ? (
        <ul className="mp-card-list" data-mp="card-list">
          {gallery.items.map((item) => (
            <ListingCard
              key={item.reference}
              item={item}
              labels={labels}
              viewer={viewer}
              baseUrl={baseUrl}
              onAdopt={onAdopt}
            />
          ))}
        </ul>
      ) : (
        <p className="mp-empty" data-mp="empty">
          {labels.chrome.exploreEmpty}
        </p>
      )}
    </main>
  );
}
