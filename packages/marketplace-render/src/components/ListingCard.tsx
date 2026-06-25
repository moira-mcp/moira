/**
 * ListingCard — one gallery card: title link (crawlable `<a href>` to the detail
 * page), summary, and a metadata row (verified badge, localized category, rating, and
 * a localized install count). Renders viewer pills ("In your library" / "Your listing")
 * only when the viewer is authenticated and the annotation is set.
 *
 * Pure + SSR-safe: counts/enums come pre-localized via the {@link Labels} bundle.
 */

import React from "react";
import type { GalleryCardView, ViewerContext } from "../types.js";
import type { Labels } from "../labels.js";
import { VerifiedBadge } from "./VerifiedBadge.js";
import { RatingStars } from "./RatingStars.js";
import { withLang } from "../links.js";

export interface ListingCardProps {
  item: GalleryCardView;
  labels: Labels;
  viewer: ViewerContext | null;
  baseUrl: string;
}

export function ListingCard({
  item,
  labels,
  viewer,
  baseUrl,
}: ListingCardProps): React.ReactElement {
  const detailUrl = withLang(`${baseUrl}/w/${item.reference}`, labels.locale);
  const isAuthenticated = viewer?.userId != null;
  return (
    <li className="mp-card" data-mp="listing-card">
      <h2 className="mp-card-title">
        <a href={detailUrl}>{item.title}</a>
      </h2>
      {item.summary ? <p className="mp-card-summary">{item.summary}</p> : null}
      <div className="mp-card-meta">
        <VerifiedBadge verified={item.verified} label={labels.chrome.verified} />
        <span className="mp-badge mp-badge-category" data-mp="category">
          {labels.category(item.category)}
        </span>
        <RatingStars
          ratingAvg={item.ratingAvg}
          ratingCount={item.ratingCount}
          ratingCountLabel={labels.ratings(item.ratingCount)}
          unratedLabel={labels.chrome.unrated}
        />
        <span className="mp-installs" data-mp="installs">
          {labels.installs(item.installCount)}
        </span>
        {item.ownerHandle ? (
          <span className="mp-owner">
            {labels.chrome.by} {item.ownerHandle}
          </span>
        ) : null}
      </div>
      {isAuthenticated && item.isOwn ? (
        <span className="mp-pill mp-pill-own" data-mp="own-pill">
          {labels.chrome.yourListing}
        </span>
      ) : null}
      {isAuthenticated && !item.isOwn && item.inLibrary ? (
        <span className="mp-pill mp-pill-library" data-mp="library-pill">
          {labels.chrome.inLibrary}
        </span>
      ) : null}
    </li>
  );
}
