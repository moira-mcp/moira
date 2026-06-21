/**
 * Remote URL Resolver
 *
 * Two modes only:
 *   1. Local  — Docker + browser on Mac      → http://localhost:PORT
 *   2. Remote — Docker + browser on PC        → http://localhost:PORT + WS connect
 *
 * In remote mode, browser runs natively on PC (not in Docker).
 * Both Docker and browser are on the same PC, so everything is localhost.
 * The only difference is Playwright connects via WebSocket.
 *
 * IMPORTANT: baseUrl is always localhost (what the browser sees).
 * In remote mode, fetchUrl points to REMOTE_HOST (for Node.js HTTP calls from Mac).
 *
 * Environment variables:
 *   DOCKER_PORT             — Port where Docker container exposes the app
 *   PLAYWRIGHT_REMOTE       — "true" to connect to remote Playwright browser via WS
 *   PLAYWRIGHT_WS_ENDPOINT  — WebSocket endpoint for remote browser
 *   REMOTE_HOST             — IP of remote PC (for Node.js fetch + default WS endpoint)
 */

export interface ResolvedTestUrls {
  /** Base URL for browser navigation — always http://localhost:PORT */
  baseUrl: string;
  /** MCP server URL (baseUrl + /mcp) */
  mcpUrl: string;
  /** URL for direct Node.js HTTP calls (fetch from Mac) — uses REMOTE_HOST in remote mode */
  fetchUrl: string;
  /** Playwright connectOptions if browser is remote, undefined otherwise */
  connectOptions?: { wsEndpoint: string };
  /** Description of the resolved mode for logging */
  mode: string;
}

export interface ResolverEnv {
  DOCKER_PORT?: string;
  PLAYWRIGHT_REMOTE?: string;
  PLAYWRIGHT_WS_ENDPOINT?: string;
  REMOTE_HOST?: string;
  [key: string]: string | undefined;
}

/**
 * Resolve test URLs based on environment configuration.
 *
 * @param env - Environment variables (defaults to process.env)
 * @returns Resolved URLs and connection options
 */
export function resolveTestUrls(env: ResolverEnv = process.env as ResolverEnv): ResolvedTestUrls {
  const port = env.DOCKER_PORT || "3030";
  const isRemote = env.PLAYWRIGHT_REMOTE === "true";

  if (isRemote && !env.REMOTE_HOST) {
    throw new Error("REMOTE_HOST is required in remote mode. Set it in .env.remote");
  }

  const remoteHost = env.REMOTE_HOST || "localhost";
  const wsEndpoint = env.PLAYWRIGHT_WS_ENDPOINT || `ws://${remoteHost}:3000/`;

  // baseUrl: always localhost (browser on same machine as Docker)
  const baseUrl = `http://localhost:${port}`;
  const mcpUrl = `${baseUrl}/mcp`;

  // fetchUrl: for Node.js HTTP calls from Mac → need remote IP in remote mode
  const fetchUrl = isRemote ? `http://${remoteHost}:${port}` : baseUrl;

  const mode = isRemote ? "Remote (PC)" : "Local (Mac)";
  const connectOptions = isRemote ? { wsEndpoint } : undefined;

  return { baseUrl, mcpUrl, fetchUrl, connectOptions, mode };
}
