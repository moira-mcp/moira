/**
 * PageHeader — the public catalog's sticky top bar: brand, theme toggle, EN/RU language
 * switch, and the session-aware auth control. PURE + SSR-safe: it renders only markup
 * with stable `data-mp` hooks; all interactivity (theme cycling, sign-out) is wired
 * imperatively by the browser hydration entry, so this component never imports auth or
 * browser-only modules and stays server-renderable.
 *
 * Anonymous viewer → a "Sign in" button linking to the SPA login route. Signed-in viewer
 * → an account chip (initials + handle) and a "Sign out" button.
 */

import React from "react";
import type { ViewerContext } from "../types.js";
import type { Labels } from "../labels.js";
import type { MarketplaceLocale } from "@mcp-moira/shared/i18n";
import { withLang, langSwitchHref } from "../links.js";

export interface PageHeaderProps {
  labels: Labels;
  viewer: ViewerContext | null;
  locale: MarketplaceLocale;
  /** Absolute origin for public links (brand → gallery). */
  baseUrl: string;
  /** Path of the current page (`/explore`, `/w/handle/slug`) for the language switch. */
  currentPath: string;
  /** SPA base path (`""` or `/app`) for same-origin app links (sign-in). */
  appPrefix: string;
}

/** Up-to-two-letter initials for the account avatar, derived from the handle. */
function initialsOf(handle: string | null): string {
  if (!handle) return "?";
  const clean = handle.replace(/[^a-zA-Z0-9]/g, "");
  return (clean.slice(0, 2) || "?").toUpperCase();
}

export function PageHeader({
  labels,
  viewer,
  locale,
  baseUrl,
  currentPath,
  appPrefix,
}: PageHeaderProps): React.ReactElement {
  const isAuthenticated = viewer?.userId != null;
  const brandHref = withLang(`${baseUrl}/explore`, locale);
  const signInHref = withLang(`${appPrefix}/login`, locale);

  return (
    <header className="mp-topbar" data-mp="topbar">
      <div className="mp-topbar-inner">
        <a className="mp-brand" href={brandHref} data-mp="brand" aria-label="Moira marketplace">
          <span className="mp-brand-mark" aria-hidden="true">
            ⚡
          </span>
          <span className="mp-brand-name">Moira</span>
        </a>

        <nav className="mp-controls" aria-label="Site controls">
          <button
            type="button"
            className="mp-icon-btn"
            data-mp="theme-toggle"
            aria-label={labels.chrome.themeToggleLabel}
            title={labels.chrome.themeToggleLabel}
          >
            <span className="mp-theme-icon" data-mp="theme-icon" aria-hidden="true">
              ◐
            </span>
          </button>

          <div
            className="mp-lang"
            data-mp="lang"
            role="group"
            aria-label={labels.chrome.languageLabel}
          >
            <a
              className={locale === "en" ? "mp-lang-opt mp-lang-active" : "mp-lang-opt"}
              href={langSwitchHref(currentPath, "en")}
              data-mp="lang-en"
              {...(locale === "en" ? { "aria-current": "true" } : {})}
            >
              EN
            </a>
            <span className="mp-lang-sep" aria-hidden="true">
              /
            </span>
            <a
              className={locale === "ru" ? "mp-lang-opt mp-lang-active" : "mp-lang-opt"}
              href={langSwitchHref(currentPath, "ru")}
              data-mp="lang-ru"
              {...(locale === "ru" ? { "aria-current": "true" } : {})}
            >
              RU
            </a>
          </div>

          {isAuthenticated ? (
            <div className="mp-account" data-mp="account">
              {/* Cross-app link back into the SPA; carries the storefront language so the
                  app lands in the same locale (session + theme are shared same-origin). */}
              <a
                className="mp-btn mp-btn-ghost"
                href={langSwitchHref(`${appPrefix}/workflows`, locale)}
                data-mp="open-app"
              >
                {labels.chrome.backToLibrary}
              </a>
              {/* Import-from-file (self-host adoption): a hidden file input + a button the
                  browser hydration wires (PageHeader is enhanced imperatively, not
                  hydrated). On success the handler redirects into the SPA library. */}
              <input
                type="file"
                className="mp-import-input"
                data-mp="import-input"
                accept="application/json,.json"
                aria-hidden="true"
                tabIndex={-1}
                hidden
              />
              <button
                type="button"
                className="mp-btn mp-btn-ghost"
                data-mp="import-btn"
                title={labels.chrome.importFromFile}
              >
                {labels.chrome.importFromFile}
              </button>
              <span className="mp-avatar" aria-hidden="true">
                {initialsOf(viewer?.handle ?? null)}
              </span>
              <span className="mp-account-handle" data-mp="account-handle">
                @{viewer?.handle ?? ""}
              </span>
              <button type="button" className="mp-btn mp-btn-ghost" data-mp="sign-out">
                {labels.chrome.signOut}
              </button>
            </div>
          ) : (
            <a className="mp-btn mp-btn-primary" href={signInHref} data-mp="sign-in">
              {labels.chrome.signIn}
            </a>
          )}
        </nav>
      </div>
    </header>
  );
}
