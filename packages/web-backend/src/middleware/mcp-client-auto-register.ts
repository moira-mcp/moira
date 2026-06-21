/**
 * MCP OAuth Client Auto-Registration Middleware
 *
 * When an MCP client (e.g. Copilot CLI) uses a stale client_id from a previous
 * database (container rebuild, DB reset), Better Auth returns `invalid_client`.
 * The error is shown in the browser as a redirect — the CLI never learns about it
 * and hangs waiting for the callback.
 *
 * This middleware intercepts `/api/auth/mcp/authorize` requests, checks if the
 * client_id exists in the DB, and auto-registers it if missing. This is safe because:
 * - Dynamic client registration (`POST /mcp/register`) is already public (no auth)
 * - PKCE protects the authorization code exchange
 * - MCP spec requires `token_endpoint_auth_method: "none"` (public clients)
 */

import type { Request, Response, NextFunction } from "express";
import { getDatabase, oauthApplication, createLogger } from "@mcp-moira/shared";
import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";

const logger = createLogger({ component: "MCPAutoRegister" });

function generateId(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

export function mcpClientAutoRegister() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    // Only intercept GET /api/auth/mcp/authorize
    if (req.method !== "GET" || !req.path.endsWith("/mcp/authorize")) {
      return next();
    }

    const clientId = req.query.client_id as string | undefined;
    const redirectUri = req.query.redirect_uri as string | undefined;

    if (!clientId || !redirectUri) {
      return next();
    }

    try {
      const db = getDatabase();

      // Check if client exists
      const [existing] = await db
        .select({ id: oauthApplication.id })
        .from(oauthApplication)
        .where(eq(oauthApplication.clientId, clientId))
        .limit(1);

      if (existing) {
        // Client exists — check if redirect_uri needs updating
        const [full] = await db
          .select({ redirectURLs: oauthApplication.redirectURLs })
          .from(oauthApplication)
          .where(eq(oauthApplication.clientId, clientId))
          .limit(1);

        if (full) {
          const existingUrls = full.redirectURLs.split(",");
          if (!existingUrls.includes(redirectUri)) {
            // MCP clients use ephemeral ports — add new redirect_uri
            existingUrls.push(redirectUri);
            await db
              .update(oauthApplication)
              .set({
                redirectURLs: existingUrls.join(","),
                updatedAt: new Date().toISOString(),
              })
              .where(eq(oauthApplication.clientId, clientId));

            logger.info("Updated redirect_uri for MCP client", {
              clientId,
              redirectUri,
            });
          }
        }
        return next();
      }

      // Client not found — auto-register as public MCP client
      const now = new Date().toISOString();
      await db.insert(oauthApplication).values({
        id: generateId(32),
        name: "MCP Client (auto-registered)",
        clientId,
        clientSecret: "",
        redirectURLs: redirectUri,
        type: "public",
        disabled: false,
        createdAt: now,
        updatedAt: now,
      });

      logger.info("Auto-registered MCP OAuth client", {
        clientId,
        redirectUri,
      });
    } catch (error) {
      logger.error("MCP client auto-register failed", error);
      // Don't block the request — let Better Auth handle the error
    }

    return next();
  };
}
