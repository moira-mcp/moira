/**
 * Static Artifacts Serving Routes
 *
 * Serves user-uploaded HTML artifacts safely. Artifact content can contain
 * JavaScript, so each artifact is:
 *   1. Served ONLY on its own origin (per-artifact subdomain
 *      `{uuid}.static.<domain>`) so the browser isolates storage / ServiceWorker
 *      / cookies between artifacts. There is no path-based serving — the uuid is
 *      always resolved from the request Host. (Localhost works over HTTP via
 *      `*.localhost` loopback; deployed domains require the `*.<domain>` wildcard
 *      TLS cert.)
 *   2. Rendered inside a sandboxed <iframe> within a Moira-controlled wrapper
 *      page. Scripts run in the frame but cannot reach the network
 *      (connect-src 'none'), submit forms, navigate the top frame, or touch the
 *      wrapper document — so the Moira footer cannot be removed or overlapped.
 *   3. Gated by a first-visit interstitial warning that the content is
 *      user-generated and not vetted by Moira.
 *
 * Routes (mounted at /static; the artifact subdomain maps onto /static at the proxy):
 * - GET  /                    - wrapper page (uuid from the Host subdomain)
 * - GET  /__frame/:uuid       - raw artifact content (iframe only; top-level
 *                               navigations redirect to the wrapper)
 * - POST /__report/:uuid      - record an abuse report
 */

import { Router, Request, Response } from "express";

import { asyncHandler } from "../middleware/error-middleware.js";
import { artifactViewLimiter } from "../middleware/rate-limit-middleware.js";
import {
  getArtifactService,
  getBaseUrl,
  createLogger,
  resolveArtifactUuidFromHost,
  getArtifactUrl,
  getSettingsService,
  getUserService,
} from "@mcp-moira/shared";
import { getTelegramClient } from "@mcp-moira/workflow-engine";

const router = Router();
const logger = createLogger({ component: "StaticArtifacts" });

/** Cookie name used to remember the interstitial was acknowledged for an artifact. */
const INTERSTITIAL_COOKIE_PREFIX = "moira_ack_";

/** Supported wrapper UI languages. */
type WrapperLang = "en" | "ru";

/** Cookie remembering the viewer's chosen wrapper language. */
const LANG_COOKIE = "moira_lang";

/**
 * Localized strings for the Moira wrapper (interstitial + footer). This covers
 * ONLY the Moira-controlled wrapper chrome — never the artifact content.
 */
const WRAPPER_I18N: Record<WrapperLang, Record<string, string>> = {
  en: {
    htmlLang: "en",
    interstitialTitle: "User-generated content",
    interstitialBody:
      "This page was created by a Moira user and is <strong>not reviewed or endorsed by Moira</strong>. It may run scripts. Do not enter passwords, payment details, or other sensitive information, and do not trust it blindly.",
    continue: "Continue to artifact",
    createdWith: "Created with",
    report: "⚑ Report",
  },
  ru: {
    htmlLang: "ru",
    interstitialTitle: "Контент создан пользователем",
    interstitialBody:
      "Эта страница создана пользователем Moira и <strong>не проверена и не одобрена Moira</strong>. Она может выполнять скрипты. Не вводите пароли, платёжные данные или другую конфиденциальную информацию и не доверяйте ей слепо.",
    continue: "Перейти к артефакту",
    createdWith: "Создано с",
    report: "⚑ Пожаловаться",
  },
};

/**
 * Pick the wrapper language. Priority: explicit cookie/override → first matching
 * Accept-Language tag → English default. (navigator.language gives the same
 * signal as Accept-Language for the wrapper; an in-page toggle sets the cookie.)
 */
function pickWrapperLang(req: Request): WrapperLang {
  const cookieLang = req.cookies?.[LANG_COOKIE];
  if (cookieLang === "ru" || cookieLang === "en") {
    return cookieLang;
  }
  const accept = (req.headers["accept-language"] || "").toLowerCase();
  // First language tag wins (highest q by header order for our two-language case).
  const first = accept.split(",")[0]?.trim() ?? "";
  if (first.startsWith("ru")) {
    return "ru";
  }
  return "en";
}

/**
 * Escape a string for safe embedding inside an HTML attribute (double-quoted).
 * Used for the iframe srcdoc payload.
 */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape a string for safe embedding inside HTML text content.
 */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * CSP for the Moira wrapper document. Strict: only our own inline styles, no
 * scripts from anywhere except our own inline interstitial/report handler
 * (kept minimal), no network. The artifact frame is loaded via srcdoc.
 */
function setWrapperSecurityHeaders(res: Response): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src 'self' data:",
      "frame-src 'self'", // the sandboxed artifact frame (srcdoc) renders as 'self'
      "form-action 'self'", // allow the footer Report form to POST to /static/__report
      "base-uri 'none'",
      "frame-ancestors 'none'", // wrapper itself must not be embedded elsewhere
    ].join("; "),
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // The wrapper is localized by Accept-Language / the moira_lang cookie, so a
  // cache must not serve one language to a viewer expecting another.
  res.setHeader("Vary", "Accept-Language, Cookie");
}

/**
 * CSP applied to the artifact content itself (served for the iframe via
 * /__frame). JavaScript is ALLOWED to run in-page, but:
 * - connect-src 'none'  → no fetch/XHR/WebSocket/beacon (no exfiltration / C2)
 * - form-action 'none'  → no form posts (no phishing submit)
 * - base-uri 'none'     → no base hijack
 * - object-src 'none'   → no plugins
 * - frame-ancestors     → only embeddable by our wrapper (same origin)
 * The iframe sandbox (allow-scripts, NO allow-same-origin, NO allow-top-navigation,
 * NO allow-forms, NO allow-popups) is the second, primary confinement layer.
 */
function setFrameSecurityHeaders(res: Response): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https:",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'self'",
    ].join("; "),
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
}

function setCacheHeaders(res: Response, uuid: string, updatedAt: number): void {
  res.setHeader("Last-Modified", new Date(updatedAt).toUTCString());
  res.setHeader("ETag", `"${uuid}-${updatedAt}"`);
  res.setHeader("Cache-Control", "public, max-age=3600");
}

/**
 * Render the Moira wrapper page: interstitial (if not acknowledged) OR the
 * artifact frame + footer strip. The footer lives in THIS document (the
 * wrapper), separate from the artifact frame, so artifact JS cannot remove or
 * overlap it.
 */
function renderWrapperPage(
  uuid: string,
  name: string,
  acknowledged: boolean,
  routeBase: string,
  lang: WrapperLang,
): string {
  const baseUrl = getBaseUrl();
  const safeName = escapeHtmlText(name);
  const safeUuid = escapeHtmlAttribute(uuid);
  const t = WRAPPER_I18N[lang];

  // Language toggle (bottom-right of the wrapper zone). Switching sets the
  // moira_lang cookie via ?lang=, preserving ack state on the current view.
  const otherLang: WrapperLang = lang === "ru" ? "en" : "ru";
  const langToggle = `<a class="moira-lang-toggle" href="?lang=${otherLang}${acknowledged ? "&ack=1" : ""}">${otherLang.toUpperCase()}</a>`;

  // The interstitial and acknowledgment use a tiny inline form-free flow:
  // acknowledging sets a cookie via a link to ?ack=1 (no JS required, no form-action).
  const interstitial = `
  <div class="moira-interstitial">
    <div class="moira-interstitial-card">
      <div class="moira-interstitial-emoji">⚠️</div>
      <h1>${t.interstitialTitle}</h1>
      <p>${t.interstitialBody}</p>
      <a class="moira-interstitial-btn" href="?ack=1">${t.continue}</a>
      <p class="moira-interstitial-sub">
        ${t.createdWith} <a href="${baseUrl}" target="_blank" rel="noopener noreferrer">Moira</a>
      </p>
    </div>
  </div>
  <div class="moira-lang-bar">${langToggle}</div>`;

  const frameAndFooter = `
  <iframe
    class="moira-artifact-frame"
    src="${routeBase}/__frame/${safeUuid}"
    sandbox="allow-scripts"
    referrerpolicy="no-referrer"
    title="${safeName}"
  ></iframe>
  <div class="moira-branding-footer">
    <span class="moira-footer-brand">
      <span class="moira-logo">✨</span>
      ${t.createdWith} <a href="${baseUrl}" target="_blank" rel="noopener noreferrer">Moira</a>
    </span>
    <span class="moira-footer-right">
      <form class="moira-report-form" method="post" action="${routeBase}/__report/${safeUuid}">
        <button type="submit" class="moira-report-link">${t.report}</button>
      </form>
      ${langToggle}
    </span>
  </div>`;

  return `<!DOCTYPE html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeName} — Moira</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      display: flex;
      flex-direction: column;
      height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #0f172a;
    }
    .moira-artifact-frame {
      flex: 1 1 auto;
      width: 100%;
      border: 0;
      display: block;
      background: #ffffff;
    }
    .moira-branding-footer {
      flex: 0 0 auto;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      color: #94a3b8;
      font-size: 12px;
      box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.3);
    }
    .moira-branding-footer a { color: #60a5fa; text-decoration: none; font-weight: 500; }
    .moira-branding-footer a:hover { text-decoration: underline; }
    .moira-logo { margin-right: 6px; }
    .moira-report-form { margin: 0; }
    .moira-report-link {
      color: #f87171;
      background: none;
      border: 0;
      padding: 0;
      font: inherit;
      cursor: pointer;
      text-decoration: none;
    }
    .moira-report-link:hover { text-decoration: underline; }
    .moira-footer-right { display: flex; align-items: center; gap: 14px; }
    .moira-lang-toggle {
      color: #94a3b8 !important;
      border: 1px solid #334155;
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 11px;
      text-decoration: none;
    }
    .moira-lang-toggle:hover { color: #e2e8f0 !important; border-color: #475569; text-decoration: none; }
    /* Language bar on the interstitial: bottom-right */
    .moira-lang-bar {
      position: fixed;
      right: 12px;
      bottom: 10px;
    }
    /* Interstitial */
    .moira-interstitial {
      flex: 1 1 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .moira-interstitial-card {
      max-width: 480px;
      text-align: center;
      background: #1e293b;
      color: #e2e8f0;
      border-radius: 12px;
      padding: 32px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    }
    .moira-interstitial-emoji { font-size: 48px; margin-bottom: 16px; }
    .moira-interstitial-card h1 { font-size: 22px; margin-bottom: 12px; color: #f1f5f9; }
    .moira-interstitial-card p { font-size: 14px; line-height: 1.6; color: #94a3b8; margin-bottom: 20px; }
    .moira-interstitial-btn {
      display: inline-block;
      background: #3b82f6;
      color: #fff;
      padding: 12px 24px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
    }
    .moira-interstitial-btn:hover { background: #2563eb; }
    .moira-interstitial-sub { margin-top: 20px; margin-bottom: 0 !important; font-size: 12px !important; }
    .moira-interstitial-sub a { color: #60a5fa; text-decoration: none; }
  </style>
</head>
<body>
  ${acknowledged ? frameAndFooter : interstitial}
</body>
</html>`;
}

function generate404Page(): string {
  const baseUrl = getBaseUrl();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Artifact Not Found - Moira</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      color: #e2e8f0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; text-align: center; padding: 20px;
    }
    .container { max-width: 500px; }
    .emoji { font-size: 64px; margin-bottom: 24px; }
    h1 { font-size: 32px; font-weight: 600; margin-bottom: 16px; color: #f1f5f9; }
    p { font-size: 16px; color: #94a3b8; margin-bottom: 24px; line-height: 1.6; }
    .button { display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500; }
    .button:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="container">
    <div class="emoji">🔍</div>
    <h1>Artifact Not Found</h1>
    <p>This artifact may have expired, been removed, or never existed. Artifacts are available for 30 days after creation.</p>
    <a href="${baseUrl}" class="button">Go to Moira</a>
  </div>
</body>
</html>`;
}

/**
 * Wrapper handler. Each artifact is served ONLY on its own origin
 * (`{uuid}.static.<domain>/`); the uuid is taken from the request Host. There is
 * no path-based serving — a request without an artifact subdomain cannot resolve
 * a uuid and gets a 404.
 */
const serveWrapper = asyncHandler(async (req: Request, res: Response) => {
  const uuid = resolveArtifactUuidFromHost(req.headers.host);
  if (!uuid) {
    return res.status(404).send(generate404Page());
  }

  const artifactService = getArtifactService();
  const artifact = await artifactService.getPublic(uuid);
  if (!artifact) {
    logger.info("Artifact not found or unavailable", { uuid });
    return res.status(404).send(generate404Page());
  }

  const acknowledged =
    req.query.ack === "1" || req.cookies?.[INTERSTITIAL_COOKIE_PREFIX + uuid] === "1";

  // Persist acknowledgment so the interstitial is shown only on first visit.
  // Cookie is scoped to this artifact's origin (per-subdomain) for isolation.
  if (req.query.ack === "1") {
    res.cookie(INTERSTITIAL_COOKIE_PREFIX + uuid, "1", {
      httpOnly: false,
      sameSite: "strict",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });
  }

  // Wrapper language: explicit ?lang= override persists in a cookie; otherwise
  // detected from Accept-Language. Localizes the Moira chrome only.
  const langOverride = req.query.lang;
  if (langOverride === "ru" || langOverride === "en") {
    res.cookie(LANG_COOKIE, langOverride, {
      httpOnly: false,
      sameSite: "strict",
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });
  }
  const lang: WrapperLang =
    langOverride === "ru" || langOverride === "en" ? langOverride : pickWrapperLang(req);

  setWrapperSecurityHeaders(res);
  setCacheHeaders(res, artifact.uuid, artifact.updatedAt);

  // The artifact subdomain maps onto the backend /static route at the proxy, so
  // the wrapper is at "/" and the frame/report URLs are root-relative.
  logger.info("Serving artifact wrapper", { uuid, acknowledged, lang });
  res.send(renderWrapperPage(artifact.uuid, artifact.name, acknowledged, "", lang));
});

// Subdomain serving: {uuid}.static.<domain>/  → uuid resolved from Host
router.get("/", artifactViewLimiter, serveWrapper);

/**
 * Raw artifact content for the sandboxed iframe. Applies the JS-enabled,
 * no-network CSP. Never includes the Moira footer (that lives in the wrapper).
 *
 * SECURITY: this route must only ever be loaded AS A FRAME inside the wrapper.
 * A top-level navigation here would render a full-page, script-running,
 * Moira-domain page with no interstitial warning and no attribution footer —
 * i.e. a phishing surface. We gate on `Sec-Fetch-Dest`: legitimate iframe loads
 * send `iframe`; a top-level navigation sends `document` (or, for clients that
 * omit the header, we conservatively treat it as top-level). Anything that is
 * not an iframe request is redirected to the wrapper so the viewer always gets
 * the interstitial + footer.
 */
router.get(
  "/__frame/:uuid",
  artifactViewLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    // Origin isolation: the frame content is served ONLY on the artifact's own
    // origin. The uuid comes from the Host subdomain; a request without an
    // artifact subdomain (e.g. on the shared/app domain) is rejected so artifacts
    // can never be embedded cross-artifact on one origin.
    const uuid = resolveArtifactUuidFromHost(req.headers.host);
    if (!uuid) {
      return res.status(404).send(generate404Page());
    }

    const fetchDest = req.headers["sec-fetch-dest"];
    if (fetchDest !== "iframe") {
      // Top-level navigation (or unknown client) — send the viewer to the
      // wrapper so they get the interstitial + footer instead of raw content.
      return res.redirect(302, "/");
    }

    const artifactService = getArtifactService();
    const artifact = await artifactService.getPublic(uuid);
    if (!artifact) {
      return res.status(404).send(generate404Page());
    }

    setFrameSecurityHeaders(res);
    setCacheHeaders(res, artifact.uuid, artifact.updatedAt);
    res.send(artifact.content);
  }),
);

/**
 * Best-effort Telegram notification to every administrator that an artifact was
 * reported. Each admin who has Telegram configured in their settings
 * (telegram.enabled not false, plus bot_token + chat_id) receives a message.
 * Reuses the per-user Telegram settings and the project's TelegramClient. Never
 * throws — a report must succeed even if no admin has Telegram or a send fails
 * (graceful degradation). Individual admin send failures do not stop the others.
 */
async function notifyAdminsOfReport(uuid: string, reportCount: number): Promise<void> {
  try {
    const adminIds = await getUserService().getAdminUserIds();
    if (adminIds.length === 0) return;

    const settings = getSettingsService();
    const ownerId = await getArtifactService().getOwnerId(uuid);
    const url = getArtifactUrl(uuid);
    const adminUrl = `${getBaseUrl()}/admin/artifacts/reported`;
    const text =
      `⚑ *Artifact reported*\n\n` +
      `An artifact has been reported by a viewer and needs review.\n` +
      `UUID: \`${uuid}\`\n` +
      (ownerId ? `Owner: \`${ownerId}\`\n` : "") +
      `Reports: ${reportCount}\n` +
      `View: ${url}\n` +
      `Admin: ${adminUrl}`;

    let sent = 0;
    for (const adminId of adminIds) {
      try {
        const enabled = await settings.get<boolean>(adminId, "telegram.enabled");
        if (enabled === false) continue;
        const botToken = await settings.get<string>(adminId, "telegram.bot_token");
        const chatId = await settings.get<string>(adminId, "telegram.chat_id");
        if (!botToken || !chatId) continue;

        const client = getTelegramClient(botToken, chatId);
        if (!client) continue;

        await client.sendMessage({ chatId, text, parseMode: "Markdown" });
        sent++;
      } catch (adminError) {
        // One admin's failure must not block notifications to the others.
        logger.warn("Report Telegram notification to admin failed (non-blocking)", {
          uuid,
          adminId,
          error: (adminError as Error).message,
        });
      }
    }
    logger.info("Sent report Telegram notifications to admins", {
      uuid,
      admins: adminIds.length,
      sent,
    });
  } catch (error) {
    // Never let notification failure affect the report response.
    logger.warn("Report Telegram notification failed (non-blocking)", {
      uuid,
      error: (error as Error).message,
    });
  }
}

/**
 * Record an abuse report for an artifact. Reachable from the footer Report form
 * (POST — a state-changing action must not be a GET, which would be triggerable
 * via <img>/prefetch/crawlers and allow report-bombing). Notifies via audit log
 * (ARTIFACT_REPORT, surfaced in the admin reported-artifacts view) AND a
 * best-effort Telegram push to every admin who has Telegram configured.
 */
router.post(
  "/__report/:uuid",
  asyncHandler(async (req: Request, res: Response) => {
    const uuid = req.params.uuid;
    const baseUrl = getBaseUrl();

    if (!uuid || uuid.length < 10) {
      return res.status(404).send(generate404Page());
    }

    const artifactService = getArtifactService();
    let reported = false;
    try {
      const reportCount = await artifactService.report(uuid);
      reported = true;
      await notifyAdminsOfReport(uuid, reportCount);
    } catch {
      // Not found / unavailable — show a neutral confirmation regardless to
      // avoid leaking which uuids exist.
      reported = false;
    }

    setWrapperSecurityHeaders(res);
    res.status(reported ? 200 : 404).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Report received — Moira</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:linear-gradient(135deg,#1e293b,#0f172a); color:#e2e8f0; min-height:100vh;
    display:flex; align-items:center; justify-content:center; text-align:center; padding:24px; }
  .card { max-width:440px; }
  .emoji { font-size:56px; margin-bottom:20px; }
  h1 { font-size:24px; margin-bottom:12px; color:#f1f5f9; }
  p { color:#94a3b8; line-height:1.6; margin-bottom:20px; }
  a { color:#60a5fa; text-decoration:none; font-weight:500; }
</style></head>
<body><div class="card">
  <div class="emoji">${reported ? "✅" : "🔍"}</div>
  <h1>${reported ? "Thanks for the report" : "Artifact not found"}</h1>
  <p>${
    reported
      ? "Our team has been notified and will review this artifact."
      : "This artifact may have expired or been removed."
  }</p>
  <a href="${baseUrl}">Go to Moira</a>
</div></body></html>`);
  }),
);

export { router as staticArtifactsRoutes };
