/**
 * Which reverse proxies the HTTP servers trust to report the client address (`TRUST_PROXY`).
 *
 * The value is handed to Express's `trust proxy` setting, which decides how `req.ip` is derived from
 * `X-Forwarded-For`. Only proxies that really sit in front of the app may be trusted: every trusted
 * hop lets the next address to its left in `X-Forwarded-For` through, and an address a client wrote
 * itself must never be reached.
 */

import { isIP } from "net";

/** A hop count, or the addresses, subnets and Express named ranges of the trusted proxies. */
export type TrustProxySetting = number | string[];

/** The in-container nginx, which every deployment has in front of the Node services. */
export const DEFAULT_TRUST_PROXY: TrustProxySetting = ["loopback"];

const NAMED_RANGES = new Set(["loopback", "linklocal", "uniquelocal"]);

function isProxyAddress(entry: string): boolean {
  if (NAMED_RANGES.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split("/");
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * Parse a `TRUST_PROXY` value. Unset or empty means the default (loopback only). A non-negative
 * integer is a hop count; anything else is a comma-separated list of addresses, CIDR subnets and the
 * named ranges `loopback`, `linklocal`, `uniquelocal`. `true` — trust every hop — is refused, because
 * it hands the client address to whoever sends the request.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_TRUST_PROXY;
  if (/^\d+$/.test(value)) return Number(value);

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const invalid = entries.filter((entry) => !isProxyAddress(entry));
  if (entries.length === 0 || invalid.length > 0) {
    throw new Error(
      `Invalid TRUST_PROXY "${raw}": expected a hop count or a comma-separated list of IP addresses, ` +
        `CIDR subnets and the names loopback, linklocal, uniquelocal` +
        (invalid.length > 0 ? ` (not accepted: ${invalid.join(", ")})` : ""),
    );
  }
  return entries;
}
