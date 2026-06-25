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
import { signOut } from "./auth/better-auth-client";

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
        appPrefix={island.seo.appPrefix ?? ""}
      />
    );
  }
  return null;
}

/** Theme values the SPA persists in localStorage `"theme"` (shared same-origin). */
type ThemeChoice = "light" | "dark" | "system";
const THEME_ORDER: ThemeChoice[] = ["light", "dark", "system"];

/** Resolve whether a theme choice paints dark (mirrors the SPA `useTheme`). */
function isDark(choice: ThemeChoice): boolean {
  if (choice === "dark") return true;
  if (choice === "light") return false;
  return !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Apply a theme choice to `<html>` (same class contract as the no-flash bootstrap). */
function applyTheme(choice: ThemeChoice): void {
  const el = document.documentElement;
  el.classList.remove("light", "dark");
  el.classList.add(isDark(choice) ? "dark" : "light");
}

/**
 * Wire the static chrome controls the SSR rendered (the header lives outside `#root`, so
 * it is enhanced imperatively rather than hydrated): the theme toggle cycles
 * light→dark→system and persists to localStorage `"theme"` (same key the SPA reads); the
 * sign-out button calls the Better Auth client then reloads so the server re-renders the
 * anonymous header. The language switch needs no JS (plain `?lang` links).
 */
function wireChrome(): void {
  const themeBtn = document.querySelector<HTMLButtonElement>('[data-mp="theme-toggle"]');
  themeBtn?.addEventListener("click", () => {
    const current = (localStorage.getItem("theme") as ThemeChoice | null) ?? "system";
    const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length] ?? "system";
    localStorage.setItem("theme", next);
    applyTheme(next);
  });

  const signOutBtn = document.querySelector<HTMLButtonElement>('[data-mp="sign-out"]');
  signOutBtn?.addEventListener("click", () => {
    signOutBtn.disabled = true;
    void signOut().finally(() => window.location.reload());
  });
}

function bootstrap(): void {
  wireChrome();
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
