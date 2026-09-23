/**
 * A readable name for the device behind a sign-in, from its User-Agent header.
 *
 * Only what a person needs to recognise their own device is extracted — the browser, the operating
 * system and whether it is a phone, a tablet or a computer. The full header stays available for
 * anyone who needs it; this is not a fingerprinting parser and does not try to be exhaustive.
 */

export type UserAgentDevice = "desktop" | "mobile" | "tablet";

export interface ParsedUserAgent {
  /** Browser name, or the name of a non-browser client (a script, a CLI), or `null`. */
  browser: string | null;
  /** Operating system, or `null` when the header does not say. */
  os: string | null;
  device: UserAgentDevice;
  /** A headless browser: an automated session rather than a person at a screen. */
  headless: boolean;
  /** A programmatic client (curl, node, Python…) rather than a browser. */
  client: boolean;
}

/** Order matters: Edge and Opera also announce Chrome, Chrome also announces Safari. */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bYaBrowser\//, "Yandex Browser"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\/|\b(?:Headless)?Chrome\/|\bChromium\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const OPERATING_SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biPhone\b|\biPad\b|\biPod\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bWindows\b/, "Windows"],
  [/\bLinux\b/, "Linux"],
];

/** Programmatic clients that announce themselves by a leading product token. */
const CLIENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^curl\//i, "curl"],
  [/^node(?:-fetch)?\b|^undici\b/i, "Node.js"],
  [/^python-requests\/|^python-urllib|^aiohttp\//i, "Python"],
  [/^axios\//i, "axios"],
  [/^Go-http-client\//i, "Go"],
  [/^PostmanRuntime\//i, "Postman"],
];

export function parseUserAgent(userAgent: string | null | undefined): ParsedUserAgent {
  const ua = (userAgent ?? "").trim();
  const client = CLIENTS.find(([pattern]) => pattern.test(ua));
  if (client) {
    return { browser: client[1], os: null, device: "desktop", headless: false, client: true };
  }
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const os = OPERATING_SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const device: UserAgentDevice = /\biPad\b|\bTablet\b/.test(ua)
    ? "tablet"
    : /\bMobi|\biPhone\b|\bAndroid\b.*\bMobile\b/.test(ua)
      ? "mobile"
      : /\bAndroid\b/.test(ua)
        ? "tablet"
        : "desktop";
  return { browser, os, device, headless: /\bHeadless/.test(ua), client: false };
}
