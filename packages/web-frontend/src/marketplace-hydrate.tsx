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
 * Interactive affordances are passed as CALLBACK PROPS that exist only here (the
 * api-client-backed side-effects): `onAdopt` installs a listing into the viewer's
 * library and reloads so the server re-renders the in-library pill. The catalog body
 * (`#root`) is hydrated; the chrome header (outside `#root`) is enhanced imperatively in
 * {@link wireChrome} (theme toggle, sign-out, and the import-from-file control).
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
  type ExploreFilter,
} from "@mcp-moira/marketplace-render/hydrate";
import { signOut } from "./auth/better-auth-client";
import { apiClient } from "./services/api-client";

/** The shape of the server-inlined initial-data island (`window.__MP__` equivalent). */
interface HydrationIsland {
  page: "explore" | "detail";
  gallery?: GalleryView;
  detail?: DetailView;
  viewer: ViewerContext | null;
  seo: SeoContext;
  /** The active gallery filter (explore page) so chips hydrate with the same state. */
  filter?: ExploreFilter;
}

/**
 * Adopt (install) a listing into the signed-in viewer's library, then reload so the
 * server re-renders the in-library state (the pill replaces the add button). Rejection
 * propagates so the AdoptButton surfaces its inline error and re-enables.
 */
async function adoptListing(listingId: string): Promise<void> {
  await apiClient.installListing(listingId);
  window.location.reload();
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
        filter={island.filter}
        onAdopt={adoptListing}
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
        onAdopt={adoptListing}
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
 * Wire the import-from-file control (signed-in chrome only): the button opens the hidden
 * file input; selecting a file uploads it via the api-client (the gated import endpoint)
 * and, on success, redirects into the SPA library (`?filter=mine`) where the imported
 * copy lands. On failure the button re-enables and an inline `role="alert"` surfaces the
 * error (no toast lib in the storefront). The control is enhanced imperatively because
 * the header is static markup outside the hydrated `#root`.
 */
function wireImport(appPrefix: string, importLabel: string, errorLabel: string): void {
  const input = document.querySelector<HTMLInputElement>('[data-mp="import-input"]');
  const button = document.querySelector<HTMLButtonElement>('[data-mp="import-btn"]');
  if (!input || !button) return;

  let status =
    button.parentElement?.querySelector<HTMLSpanElement>('[data-mp="import-error"]') ?? null;

  button.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = ""; // allow re-selecting the same file
    if (!file) return;
    button.disabled = true;
    if (status) status.remove();
    void apiClient
      .importWorkflowFile(file)
      .then(() => {
        window.location.assign(`${appPrefix}/workflows?filter=mine`);
      })
      .catch(() => {
        button.disabled = false;
        button.title = importLabel;
        status = document.createElement("span");
        status.className = "mp-adopt-error";
        status.setAttribute("data-mp", "import-error");
        status.setAttribute("role", "alert");
        status.textContent = errorLabel;
        button.insertAdjacentElement("afterend", status);
      });
  });
}

/**
 * Wire the static chrome controls the SSR rendered (the header lives outside `#root`, so
 * it is enhanced imperatively rather than hydrated): the theme toggle cycles
 * light→dark→system and persists to localStorage `"theme"` (same key the SPA reads); the
 * sign-out button calls the Better Auth client then reloads so the server re-renders the
 * anonymous header; the import control uploads a workflow file (signed-in only). The
 * language switch and cross-app link need no JS (plain `?lang` links).
 */
function wireChrome(island: HydrationIsland | null): void {
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

  const appPrefix = island?.seo.appPrefix ?? "";
  const labels = makeLabels(island?.seo.locale ?? "en");
  wireImport(appPrefix, labels.chrome.importFromFile, labels.chrome.importError);
}

function bootstrap(): void {
  const root = document.getElementById("root");
  const island = readIsland();
  wireChrome(island);
  if (!root || !island) {
    return; // No SSR container / island → nothing to hydrate (page stays as served).
  }
  const tree = buildTree(island);
  if (tree) {
    hydrateRoot(root, tree);
  }
}

bootstrap();
