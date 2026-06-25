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
import { withLang } from "../links.js";

export interface ListingDetailProps {
  detail: DetailView;
  labels: Labels;
  viewer: ViewerContext | null;
  baseUrl: string;
  /** SPA base path (`""` or `/app`) for the anonymous sign-in CTA. Defaults to `""`. */
  appPrefix?: string;
}

export function ListingDetail({
  detail,
  labels,
  viewer,
  baseUrl,
  appPrefix = "",
}: ListingDetailProps): React.ReactElement {
  const isAuthenticated = viewer?.userId != null;
  const startCommand = `start("${detail.reference}")`;
  const signInHref = withLang(`${appPrefix}/login`, labels.locale);
  return (
    <main className="mp-detail" data-mp="detail">
      <nav className="mp-breadcrumb" aria-label="Breadcrumb">
        <a href={withLang(`${baseUrl}/explore`, labels.locale)}>{labels.chrome.backToExplore}</a>
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
        <div className="mp-start" data-mp="start">
          <p className="mp-start-label">{labels.chrome.startHint}</p>
          <code data-mp="start-command">{startCommand}</code>
        </div>
        {/* Action area, context-appropriate: anonymous → gated sign-in CTA; a signed-in
            viewer who neither owns nor already has the flow → an add affordance (the real
            add action lands in Step 14); an owner or an in-library viewer → no action (the
            "Your listing" / "In your library" pill above already conveys their state). */}
        {!isAuthenticated ? (
          <div className="mp-actions" data-mp="actions">
            <a className="mp-btn mp-btn-primary" href={signInHref} data-mp="signin-cta">
              {labels.chrome.signInToAdd}
            </a>
          </div>
        ) : !detail.isOwn && !detail.inLibrary ? (
          <div className="mp-actions" data-mp="actions">
            <a
              className="mp-btn mp-btn-primary"
              href={withLang(`${baseUrl}/explore`, labels.locale)}
              data-mp="add-cta"
            >
              {labels.chrome.addToLibrary}
            </a>
          </div>
        ) : null}
      </article>
    </main>
  );
}
