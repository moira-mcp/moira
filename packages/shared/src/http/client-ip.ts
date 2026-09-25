/**
 * One client address for every consumer: rate limits, their whitelist, audit records, session
 * country and Better Auth's own session address all use the address Express derives through the
 * configured trusted proxies (`TRUST_PROXY`), never an `X-Forwarded-For` entry read directly.
 */

import type { Application, NextFunction, Request, RequestHandler, Response } from "express";
import { getTrustProxy } from "../config/env.js";

/**
 * Request header that carries `req.ip` to code that only sees request headers (Better Auth hooks).
 * The server writes it itself on every request, replacing whatever a client sent under that name.
 */
export const CLIENT_IP_HEADER = "x-moira-client-ip";

/** Apply the configured proxy trust to an Express application. Throws on an invalid `TRUST_PROXY`. */
export function applyTrustProxy(app: Application): void {
  app.set("trust proxy", getTrustProxy());
}

/** Write the resolved client address into {@link CLIENT_IP_HEADER}, overwriting a client's value. */
export function clientIpHeaderMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.ip) {
      req.headers[CLIENT_IP_HEADER] = req.ip;
    } else {
      delete req.headers[CLIENT_IP_HEADER];
    }
    next();
  };
}

/** The client address stored by {@link clientIpHeaderMiddleware}, for code that only has headers. */
export function clientIpFromHeaders(headers: Headers | null | undefined): string | undefined {
  return headers?.get(CLIENT_IP_HEADER)?.trim() || undefined;
}
