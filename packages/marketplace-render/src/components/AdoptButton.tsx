/**
 * AdoptButton — the "Add to library" affordance shared by {@link ListingCard} and
 * {@link ListingDetail}. PURE + SSR-safe and dependency-free (only React): the actual
 * adoption side-effect (install the listing, then reload so the server re-renders the
 * in-library pill) is owned by the OPTIONAL `onAdopt` callback the browser hydration
 * passes; the server render passes none, so the markup is identical on both sides (no
 * hydration mismatch) and the button is simply inert without JS.
 *
 * Because the storefront has no toast library, the transient pending + failure states
 * are local React state rendered inline: while the install promise is in flight the
 * button is disabled and shows the "Adding…" label; on rejection it re-enables and an
 * inline `role="alert"` carries the error. On success the callback navigates away
 * (reload), so no "added" state needs to be reflected here.
 */

import React from "react";
import type { Labels } from "../labels.js";

export interface AdoptButtonProps {
  listingId: string;
  labels: Labels;
  /**
   * Adopt side-effect (install + reload). Provided only by the browser hydration; absent
   * in the SSR render, where the button renders identically but does nothing on click.
   */
  onAdopt?: (listingId: string) => void | Promise<void>;
}

export function AdoptButton({ listingId, labels, onAdopt }: AdoptButtonProps): React.ReactElement {
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const handleClick = (): void => {
    if (!onAdopt || pending) return;
    setPending(true);
    setFailed(false);
    // On success the callback reloads the page (the pending state simply persists until
    // navigation); on failure we re-enable and surface the inline error.
    Promise.resolve(onAdopt(listingId)).catch(() => {
      setPending(false);
      setFailed(true);
    });
  };

  return (
    <>
      <button
        type="button"
        className="mp-btn mp-btn-primary"
        data-mp="adopt-btn"
        disabled={pending}
        onClick={handleClick}
      >
        {pending ? labels.chrome.adding : labels.chrome.addToLibrary}
      </button>
      {failed ? (
        <span className="mp-adopt-error" data-mp="adopt-error" role="alert">
          {labels.chrome.adoptError}
        </span>
      ) : null}
    </>
  );
}
