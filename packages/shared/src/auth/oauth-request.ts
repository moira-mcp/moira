import { eq } from "drizzle-orm";
import { getDatabase } from "../database/connection.js";
import { oauthClient } from "../database/schema.js";
import { getMcpUrl } from "../config/urls.js";

const aliases: Record<string, string> = {
  "/mcp/authorize": "/oauth2/authorize",
  "/mcp/register": "/oauth2/register",
  "/mcp/token": "/oauth2/token",
  "/mcp/userinfo": "/oauth2/userinfo",
};

/** Cached client metadata can address the old issuer URLs after a server upgrade. */
export async function normalizeOAuthRequest(request: Request): Promise<Request> {
  const url = new URL(request.url);
  const prefix = "/api/auth";
  if (!url.pathname.startsWith(prefix + "/")) return request;
  const route = url.pathname.slice(prefix.length);
  const target = aliases[route] ?? route;
  if (aliases[route]) url.pathname = prefix + target;
  // A client that previously requested a single MCP resource implicitly still receives that audience.
  if (
    target === "/oauth2/authorize" &&
    request.method === "GET" &&
    !url.searchParams.has("resource") &&
    !url.searchParams.has("sig")
  ) {
    url.searchParams.set("resource", getMcpUrl());
  }
  let updated = url.href === request.url ? request : new Request(url, request);
  // The old MCP endpoint accepted JSON token requests as well as OAuth form posts.
  if (
    route === "/mcp/token" &&
    request.method === "POST" &&
    updated.headers.get("content-type")?.startsWith("application/json")
  ) {
    const json: unknown = await updated
      .clone()
      .json()
      .catch(() => null);
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(json)) {
        if (typeof value === "string") form.append(key, value);
        else if (
          key === "resource" &&
          Array.isArray(value) &&
          value.every((v) => typeof v === "string")
        )
          for (const uri of value) form.append(key, uri);
        else return updated;
      }
      const headers = new Headers(updated.headers);
      headers.delete("content-length");
      headers.set("content-type", "application/x-www-form-urlencoded");
      updated = new Request(url, { method: "POST", headers, body: form.toString() });
    }
  }
  if (
    target !== "/oauth2/token" ||
    updated.method !== "POST" ||
    updated.headers.has("authorization")
  )
    return updated;
  if (!updated.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))
    return updated;
  const fields = new URLSearchParams(await updated.clone().text());
  const id = fields.get("client_id"),
    secret = fields.get("client_secret");
  if (
    !id ||
    !secret ||
    fields.getAll("client_id").length !== 1 ||
    fields.getAll("client_secret").length !== 1
  )
    return updated;
  // 1.6 stored the confidential client's secret but not whether it had used basic or post.
  // Only a migrated confidential registration receives this equivalent transport translation.
  const [client] = await getDatabase()
    .select({ legacy: oauthClient.legacyAuthMethod, method: oauthClient.tokenEndpointAuthMethod })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, id))
    .limit(1);
  if (!client?.legacy || client.method !== "client_secret_basic") return updated;
  fields.delete("client_secret");
  fields.delete("client_id");
  const headers = new Headers(updated.headers);
  headers.delete("content-length");
  headers.set(
    "authorization",
    "Basic " +
      Buffer.from(encodeURIComponent(id) + ":" + encodeURIComponent(secret)).toString("base64"),
  );
  return new Request(url, { method: "POST", headers, body: fields.toString() });
}
