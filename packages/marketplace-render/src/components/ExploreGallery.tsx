/**
 * ExploreGallery — the public catalog grid: a localized header with the result count and
 * partition-aware filter chips (All / Official / Community, each with its count), and a
 * semantic `<ul>` of {@link ListingCard}s. When nothing matches, it distinguishes a
 * no-results SEARCH/FILTER (search-specific copy + a clear-filters link) from a genuinely
 * empty catalog. Wrapped in a `<main>` so the document is crawlable without JS. Pure +
 * SSR-safe.
 */

import React from "react";
import type { GalleryView, ViewerContext, ExploreFilter, GalleryFacets } from "../types.js";
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
  /** Per-partition counts for the chips (All / Official / Community). */
  facets?: GalleryFacets;
  /** Adopt side-effect (install + reload) threaded to each card; hydration only. */
  onAdopt?: (listingId: string) => void | Promise<void>;
}

export function ExploreGallery({
  gallery,
  labels,
  viewer,
  baseUrl,
  filter,
  facets,
  onAdopt,
}: ExploreGalleryProps): React.ReactElement {
  const locale = labels.locale;
  const official = filter?.official ?? false;
  const community = filter?.community ?? false;
  const search = filter?.search ?? "";
  // "Filtered" = any partition or a search is active. Drives the result-count wording and
  // the no-results copy so "0 results" for a search never reads as "no catalog".
  const isFiltered = official || community || search.length > 0;
  const isAll = !official && !community;

  // Chip links preserve the active search so switching partition keeps the query.
  const chips = [
    {
      key: "all",
      label: labels.chrome.filterAll,
      count: facets?.all,
      active: isAll,
      href: exploreHref(baseUrl, locale, { search }),
    },
    {
      key: "official",
      label: labels.chrome.filterOfficial,
      count: facets?.official,
      active: official,
      href: exploreHref(baseUrl, locale, { official: true, search }),
    },
    {
      key: "community",
      label: labels.chrome.filterCommunity,
      count: facets?.community,
      active: community,
      href: exploreHref(baseUrl, locale, { community: true, search }),
    },
  ];

  return (
    <main className="mp-explore" data-mp="explore">
      <header className="mp-header">
        <h1>{labels.chrome.exploreTitle}</h1>
        <p className="mp-subtitle">{labels.chrome.exploreSubtitle}</p>
        <p className="mp-total" data-mp="total">
          {isFiltered ? labels.results(gallery.total) : labels.published(gallery.total)}
        </p>
        {/* Filter chips are LINKS (crawlable + SSR-navigable): each carries the matching
            `?official`/`?community`/`?search`/`?lang` query so the server re-renders the
            scoped, in-language gallery. The active chip is driven by the threaded filter,
            not client state. The per-chip counts make the partition explicit and
            non-redundant (All = Official + Community). */}
        <nav className="mp-chips" data-mp="filter-chips" aria-label={labels.chrome.filterAll}>
          {chips.map((chip) => (
            <a
              key={chip.key}
              className={chip.active ? "mp-chip mp-chip-active" : "mp-chip"}
              href={chip.href}
              data-mp={`chip-${chip.key}`}
              aria-pressed={chip.active ? "true" : "false"}
            >
              {chip.label}
              {typeof chip.count === "number" ? (
                <span className="mp-chip-count" data-mp="chip-count">
                  {chip.count}
                </span>
              ) : null}
            </a>
          ))}
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
      ) : isFiltered ? (
        <div className="mp-empty" data-mp="empty-search">
          <p className="mp-empty-text">{labels.chrome.exploreNoMatch}</p>
          <a className="mp-empty-clear" href={exploreHref(baseUrl, locale, {})} data-mp="clear-search">
            {labels.chrome.clearSearch}
          </a>
        </div>
      ) : (
        <p className="mp-empty" data-mp="empty">
          {labels.chrome.exploreEmpty}
        </p>
      )}
    </main>
  );
}
