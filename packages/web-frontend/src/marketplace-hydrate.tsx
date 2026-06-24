/**
 * marketplace-hydrate — the browser hydration entry for the SSR public catalog pages
 * (`/explore`, `/w/:handle/:slug`). The web-backend renders the SAME React components
 * from `@mcp-moira/marketplace-render` to an HTML string inside `#root` and inlines the
 * exact view-model + context as a JSON island (`#mp-bootstrap`). Here we read that
 * island, rebuild the identical React tree, and call `hydrateRoot` on `#root` to take
 * over interactivity WITHOUT re-fetching or re-rendering from scratch.
 *
 * Progressive enhancement: if this script never runs (JS disabled) the SSR HTML is
 * already complete and usable; hydration only upgrades the page. Bundled by webpack as
 * a SECOND entry with a STABLE filename (`marketplace-hydrate.js`, no contenthash) so
 * the backend can reference it deterministically.
 *
 * Step 11 scope: anonymous viewer only (`viewer = null`). Session-aware hydration is
 * Step 12.
 */

import React from "react";
import { hydrateRoot } from "react-dom/client";
import {
  ExploreGallery,
  ListingDetail,
  makeLabels,
  type GalleryView,
  type DetailView,
  type ViewerContext,
  type SeoContext,
} from "@mcp-moira/marketplace-render/hydrate";

/** The shape of the server-inlined initial-data island (`window.__MP__` equivalent). */
interface HydrationIsland {
  page: "explore" | "detail";
  gallery?: GalleryView;
  detail?: DetailView;
  viewer: ViewerContext | null;
  seo: SeoContext;
}

/** Parse the `#mp-bootstrap` JSON island the server inlined; null if absent/malformed. */
function readIsland(): HydrationIsland | null {
  const el = document.getElementById("mp-bootstrap");
  if (!el?.textContent) {
    return null;
  }
  try {
    return JSON.parse(el.textContent) as HydrationIsland;
  } catch {
    return null;
  }
}

/** Rebuild the exact React element the server rendered for this page. */
function buildTree(island: HydrationIsland): React.ReactElement | null {
  const labels = makeLabels(island.seo.locale);
  const baseUrl = island.seo.baseUrl;
  if (island.page === "explore" && island.gallery) {
    return (
      <ExploreGallery
        gallery={island.gallery}
        labels={labels}
        viewer={island.viewer}
        baseUrl={baseUrl}
      />
    );
  }
  if (island.page === "detail" && island.detail) {
    return (
      <ListingDetail
        detail={island.detail}
        labels={labels}
        viewer={island.viewer}
        baseUrl={baseUrl}
      />
    );
  }
  return null;
}

function bootstrap(): void {
  const root = document.getElementById("root");
  const island = readIsland();
  if (!root || !island) {
    return; // No SSR container / island → nothing to hydrate (page stays as served).
  }
  const tree = buildTree(island);
  if (tree) {
    hydrateRoot(root, tree);
  }
}

bootstrap();
