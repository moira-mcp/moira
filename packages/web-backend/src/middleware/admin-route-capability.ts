import type { Request } from "express";
import type { Feature } from "@mcp-moira/shared";

function mountedAdminPath(req: Request): string {
  const pathname = req.path.toLowerCase();
  const mountedPath = pathname.replace(/^\/api\/admin(?=\/|$)/, "") || "/";

  // Express routers are case-insensitive and non-strict by default. Apply the
  // same semantics before capability selection so every spelling accepted by
  // a protected route receives the same authorization decision.
  return mountedPath.length > 1 ? mountedPath.replace(/\/+$/, "") : mountedPath;
}

function matchesSurface(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function selectAdminRouteCapability(req: Request): Feature | null {
  const pathname = mountedAdminPath(req);
  if (pathname === "/stats") {
    return "adminAnalytics";
  }

  const broadPrefixes = ["/workflows", "/executions", "/artifacts", "/sessions/all"];
  const isUserArtifactOperation =
    /^\/users\/[^/]+\/(?:artifacts\/takedown|artifact-quota)(?:\/|$)/.test(pathname);

  return broadPrefixes.some((prefix) => matchesSurface(pathname, prefix)) || isUserArtifactOperation
    ? "multiUserAdmin"
    : null;
}

export function selectAnalyticsSurfaceCapability(req: Request): Feature {
  return matchesSurface(mountedAdminPath(req), "/operational")
    ? "adminOperations"
    : "adminAnalytics";
}
