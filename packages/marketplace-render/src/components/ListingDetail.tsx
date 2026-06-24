/**
 * ListingDetail — the flow detail page body: a breadcrumb back to the gallery, the
 * title + metadata row (verified, localized category, rating, localized install count),
 * the summary, a localized step count + tags, and the start-command hint. Renders the
 * viewer pills ("In your library" / "Your listing") when authenticated. Wrapped in
 * `<article>` for crawlability. Pure + SSR-safe.
 */

import React from "react";
import type { DetailView, ViewerContext } from "../types.js";
import type { Labels } from "../labels.js";
import { VerifiedBadge } from "./VerifiedBadge.js";
import { RatingStars } from "./RatingStars.js";

export interface ListingDetailProps {
  detail: DetailView;
  labels: Labels;
  viewer: ViewerContext | null;
  baseUrl: string;
}

export function ListingDetail({
  detail,
  labels,
  viewer,
  baseUrl,
}: ListingDetailProps): React.ReactElement {
  const isAuthenticated = viewer?.userId != null;
  const startCommand = `start("${detail.reference}")`;
  return (
    <main className="mp-detail" data-mp="detail">
      <nav className="mp-breadcrumb" aria-label="Breadcrumb">
        <a href={`${baseUrl}/explore`}>{labels.chrome.backToExplore}</a>
      </nav>
      <article className="mp-detail-article" data-mp="detail-article">
        <h1 className="mp-detail-title">{detail.title}</h1>
        <div className="mp-detail-meta">
          <VerifiedBadge verified={detail.verified} label={labels.chrome.verified} />
          <span className="mp-badge mp-badge-category" data-mp="category">
            {labels.category(detail.category)}
          </span>
          <RatingStars
            ratingAvg={detail.ratingAvg}
            ratingCount={detail.ratingCount}
            ratingCountLabel={labels.ratings(detail.ratingCount)}
            unratedLabel={labels.chrome.unrated}
          />
          <span className="mp-installs" data-mp="installs">
            {labels.installs(detail.installCount)}
          </span>
          {detail.ownerHandle ? (
            <span className="mp-owner">
              {labels.chrome.by} {detail.ownerHandle}
            </span>
          ) : null}
        </div>
        {isAuthenticated && detail.isOwn ? (
          <span className="mp-pill mp-pill-own" data-mp="own-pill">
            {labels.chrome.yourListing}
          </span>
        ) : null}
        {isAuthenticated && !detail.isOwn && detail.inLibrary ? (
          <span className="mp-pill mp-pill-library" data-mp="library-pill">
            {labels.chrome.inLibrary}
          </span>
        ) : null}
        {detail.summary ? <p className="mp-detail-summary">{detail.summary}</p> : null}
        <p className="mp-detail-stats" data-mp="steps">
          {labels.steps(detail.stepCount)}
          {detail.tags.length > 0 ? (
            <span className="mp-detail-tags" data-mp="tags">
              {" · "}
              {labels.chrome.tagsLabel}: {detail.tags.join(", ")}
            </span>
          ) : null}
        </p>
        <p className="mp-start-hint">
          {labels.chrome.startHint}: <code>{startCommand}</code>
        </p>
      </article>
    </main>
  );
}
