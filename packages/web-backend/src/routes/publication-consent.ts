import { randomBytes } from "node:crypto";
import express, { Router, type ErrorRequestHandler, type Request } from "express";
import {
  getAppPrefix,
  getDatabase,
  getFeatureResolver,
  PublicationRepository,
  PUBLICATION_VISIT_TTL_MS,
} from "@mcp-moira/shared";
import { publicationCookieName } from "@mcp-moira/shared/auth";
import { getBaseUrl, isProduction } from "@mcp-moira/shared/urls";
import { publicationLimiter } from "../middleware/rate-limit-middleware.js";
import { logger } from "../utils/logger.js";

const copy = {
  en: {
    title: "Share how you found Moira?",
    detail:
      "With your permission, this site counts this visit and saves a cookie for seven days. If you create an account in this browser, the site counts your registration and later workflow use toward the last publication you accepted. Only this installation’s administrators can see the results.",
    accept: "Allow and continue",
    decline: "Continue without attribution",
  },
  ru: {
    title: "Сообщить, откуда вы узнали о Мойре?",
    detail:
      "С вашего разрешения сайт учтёт этот переход и сохранит cookie на семь дней. Если вы создадите аккаунт в этом браузере, сайт отнесёт регистрацию и последующие запуски процессов к последней публикации, для которой вы дали согласие. Результаты видны только администраторам этой установки.",
    accept: "Разрешить и продолжить",
    decline: "Продолжить без учёта",
  },
};

function lang(req: Request): keyof typeof copy {
  return req.query.lang === "ru" ? "ru" : "en";
}

function landing(req: Request): string {
  if (lang(req) === "en") return "/";
  return getAppPrefix() ? "/ru/" : "/?lang=ru";
}

function sameOriginSubmission(req: Request): boolean {
  const origin = req.get("origin");
  if (origin && origin !== "null") return origin === getBaseUrl();
  // A no-referrer document can submit a native form with an opaque Origin.
  return req.get("sec-fetch-site") === "same-origin";
}

export const publicationConsentRoutes = Router();
publicationConsentRoutes.use((_req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  next();
});
publicationConsentRoutes.use(publicationLimiter);

publicationConsentRoutes.get("/:id", (req, res) => {
  if (!getFeatureResolver().isEnabled("adminAnalytics")) {
    res.redirect(303, landing(req));
    return;
  }
  const locale = lang(req);
  const message = copy[locale];
  res.type("html").send(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${message.title}</title>
<style>body{font:1.1rem/1.55 system-ui,sans-serif;color:#262322;background:#faf9f6;margin:0}main{max-width:37rem;margin:12vh auto;padding:1.5rem}h1{font-size:clamp(1.6rem,5vw,2.3rem);line-height:1.2}form{display:flex;flex-wrap:wrap;gap:.75rem}button{font:inherit;cursor:pointer;color:inherit;background:white;border:1px solid #666;border-radius:.4rem;padding:.55rem .9rem}</style></head>
<body><main><h1>${message.title}</h1><p>${message.detail}</p><form method="post">
<button name="choice" value="accept">${message.accept}</button><button name="choice" value="decline">${message.decline}</button>
</form></main></body></html>`);
});

publicationConsentRoutes.post(
  "/:id",
  express.urlencoded({ extended: false, limit: "1kb", parameterLimit: 1 }),
  async (req, res) => {
    if (!sameOriginSubmission(req)) {
      res.sendStatus(403);
      return;
    }
    const choice: unknown = req.body?.choice;
    if (choice !== "accept" && choice !== "decline") {
      res.sendStatus(400);
      return;
    }
    const cookie = { httpOnly: true, sameSite: "lax" as const, secure: isProduction(), path: "/" };
    if (choice === "decline") {
      res.clearCookie(publicationCookieName(), cookie);
    } else if (getFeatureResolver().isEnabled("adminAnalytics")) {
      const token = await new PublicationRepository(getDatabase()).accept(req.params.id);
      // An unknown publication is indistinguishable from a valid one to a visitor.
      res.cookie(publicationCookieName(), token ?? randomBytes(32).toString("base64url"), {
        ...cookie,
        maxAge: PUBLICATION_VISIT_TTL_MS,
      });
    }
    res.redirect(303, landing(req));
  },
);
publicationConsentRoutes.use((_req, res) => res.sendStatus(404));

// Keep parser diagnostics, submitted bodies and database errors inside this boundary.
const handleConsentError: ErrorRequestHandler = (error, _req, res, _next) => {
  const status: unknown = error?.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500) {
    res.sendStatus(status);
    return;
  }
  logger.warn("Publication consent request failed");
  res.sendStatus(500);
};
publicationConsentRoutes.use(handleConsentError);
