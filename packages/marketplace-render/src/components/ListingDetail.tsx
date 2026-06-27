/**
 * ListingDetail — the flow detail page body: a breadcrumb back to the gallery, the
 * title + metadata row (verified, localized category, rating, localized install count),
 * the summary, a localized step count + tags, and a human "How to use it" panel.
 *
 * Moira is an MCP utility — the END USER does NOT execute MCP tools — so the page does
 * NOT show a `start(...)` developer command. Instead it explains the real model: ADOPT
 * the flow (add it to your agent's library in the cloud, or export/import on self-host)
 * and RUN it by asking your agent in plain language. Renders the viewer pills
 * ("In your library" / "Your listing") when authenticated. Wrapped in `<article>` for
 * crawlability. Pure + SSR-safe.
 */

import React from "react";
import type { DetailView, ViewerContext } from "../types.js";
import type { Labels } from "../labels.js";
import { VerifiedBadge } from "./VerifiedBadge.js";
import { RatingStars } from "./RatingStars.js";
import { AdoptButton } from "./AdoptButton.js";
import { withLang, exportHref } from "../links.js";

export interface ListingDetailProps {
  detail: DetailView;
  labels: Labels;
  viewer: ViewerContext | null;
  baseUrl: string;
  /** SPA base path (`""` or `/app`) for the anonymous sign-in CTA. Defaults to `""`. */
  appPrefix?: string;
  /** Adopt side-effect (install + reload), wired by the browser hydration only. */
  onAdopt?: (listingId: string) => void | Promise<void>;
}

export function ListingDetail({
  detail,
  labels,
  viewer,
  baseUrl,
  appPrefix = "",
  onAdopt,
}: ListingDetailProps): React.ReactElement {
  const isAuthenticated = viewer?.userId != null;
  const signInHref = withLang(`${appPrefix}/login`, labels.locale);
  const downloadHref = exportHref(baseUrl, detail.reference);
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
        {/* Human "how to use" model — NOT an MCP `start(...)` command. Step 1 adopts the
            flow (context-aware: anonymous → gated sign-in CTA; signed-in non-owner not yet
            in library → add affordance, the real action lands in Step 14; owner /
            in-library → a confirming line, no button). Step 2 runs it by asking the agent
            in plain language. */}
        <section className="mp-howto" data-mp="howto">
          <h2 className="mp-howto-title">{labels.chrome.howToUse}</h2>
          <ol className="mp-steps">
            <li className="mp-step">
              <span className="mp-step-num" aria-hidden="true">
                1
              </span>
              <div className="mp-step-body">
                <h3 className="mp-step-title">{labels.chrome.adoptStep}</h3>
                {isAuthenticated && detail.isOwn ? (
                  <p className="mp-step-text">{labels.chrome.yourListing}</p>
                ) : isAuthenticated && detail.inLibrary ? (
                  <p className="mp-step-text">{labels.chrome.inLibrary}</p>
                ) : (
                  <>
                    <p className="mp-step-text">{labels.chrome.adoptCloud}</p>
                    <div className="mp-detail-actions" data-mp="detail-actions">
                      {isAuthenticated ? (
                        <AdoptButton
                          listingId={detail.listingId}
                          labels={labels}
                          onAdopt={onAdopt}
                        />
                      ) : (
                        <a className="mp-btn mp-btn-primary" href={signInHref} data-mp="signin-cta">
                          {labels.chrome.signInToAdd}
                        </a>
                      )}
                    </div>
                  </>
                )}
                <p className="mp-step-note">{labels.chrome.adoptSelfHost}</p>
                {/* Download is public (anyone, JS-free) and is the self-host export source
                    referenced by the note above; the endpoint enforces access server-side. */}
                <a
                  className="mp-btn mp-btn-ghost mp-btn-sm"
                  href={downloadHref}
                  download
                  data-mp="download-link"
                >
                  {labels.chrome.download}
                </a>
              </div>
            </li>
            <li className="mp-step">
              <span className="mp-step-num" aria-hidden="true">
                2
              </span>
              <div className="mp-step-body">
                <h3 className="mp-step-title">{labels.chrome.runStep}</h3>
                <p className="mp-step-text">{labels.chrome.runLead}:</p>
                <p className="mp-say" data-mp="run-instruction">
                  {`${labels.chrome.runVerb} “${detail.title}”`}
                </p>
              </div>
            </li>
          </ol>
        </section>
      </article>
    </main>
  );
}
