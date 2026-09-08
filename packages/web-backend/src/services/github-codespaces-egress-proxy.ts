import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const SOCKET_PATH = "/run/moira-workspace-egress/proxy.sock";
const ALLOWED_HOSTS = [
  "github.com",
  ".github.com",
  ".githubusercontent.com",
  ".github.dev",
  ".tunnels.api.visualstudio.com",
] as const;

export function allowedHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return ALLOWED_HOSTS.some((entry) =>
    entry.startsWith(".")
      ? normalized.endsWith(entry) && normalized.length > entry.length
      : normalized === entry,
  );
}

function publicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    return false;
  const [a, b, c] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export function publicIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return publicIpv4(address);
  if (version !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return publicIpv4(normalized.slice(7));
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

function reject(client: Duplex, status = "403 Forbidden"): void {
  client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

const server = createServer((_request, response) => {
  response.writeHead(405, { connection: "close" });
  response.end();
});

server.on("connect", async (request, client, head) => {
  const separator = request.url?.lastIndexOf(":") ?? -1;
  const host = request.url?.slice(0, separator) ?? "";
  const port = Number(request.url?.slice(separator + 1));
  if (port !== 443 || !allowedHost(host) || isIP(host) !== 0) {
    reject(client);
    return;
  }
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    const target = addresses.find((entry) => publicIp(entry.address));
    if (!target || addresses.some((entry) => !publicIp(entry.address)))
      throw new Error("unsafe DNS answer");
    let established = false;
    const upstream = connect({ host: target.address, port, family: target.family }, () => {
      if (
        upstream.remoteAddress !== target.address &&
        upstream.remoteAddress !== `::ffff:${target.address}`
      ) {
        upstream.destroy(new Error("peer address changed"));
        return;
      }
      established = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.setTimeout(60_000, () => upstream.destroy());
    upstream.once("error", () => {
      if (established) client.destroy();
      else reject(client, "502 Bad Gateway");
    });
    client.once("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
  } catch {
    reject(client, "502 Bad Gateway");
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mkdir(dirname(SOCKET_PATH), { recursive: true });
  await unlink(SOCKET_PATH).catch(() => undefined);
  server.listen(SOCKET_PATH, async () => {
    // The socket carries only encrypted CONNECT tunnels and no credentials.
    // World-connectable mode lets the deliberately unprivileged, networkless
    // connector bridge use a volume created by a separate container.
    await chmod(SOCKET_PATH, 0o666);
    process.stdout.write("workspace-egress-proxy-ready\n");
  });
}
