/**
 * ExploreGallery — the public catalog grid: a localized header with the total count
 * and a semantic `<ul>` of {@link ListingCard}s (or an empty-state message). Wrapped in
 * a `<main>` so the document is crawlable without JS. Pure + SSR-safe.
 */

import React from "react";
import type { GalleryView, ViewerContext } from "../types.js";
import type { Labels } from "../labels.js";
import { ListingCard } from "./ListingCard.js";

export interface ExploreGalleryProps {
  gallery: GalleryView;
  labels: Labels;
  viewer: ViewerContext | null;
  baseUrl: string;
}

export function ExploreGallery({
  gallery,
  labels,
  viewer,
  baseUrl,
}: ExploreGalleryProps): React.ReactElement {
  return (
    <main className="mp-explore" data-mp="explore">
      <header className="mp-header">
        <h1>{labels.chrome.exploreTitle}</h1>
        <p className="mp-subtitle">{labels.chrome.exploreSubtitle}</p>
        <p className="mp-total" data-mp="total">
          {labels.published(gallery.total)}
        </p>
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
