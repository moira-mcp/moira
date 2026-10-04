import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { domainName, LocalRefusal } from "./policy.js";

const privateV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) privateV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const excludedV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) excludedV6.addSubnet(address, prefix, "ipv6");

/** Conservative global-unicast admission; transition and mapped address forms stay denied. */
export function publicAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) return !privateV4.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !excludedV6.check(address, "ipv6");
}

export interface ResolvedTarget { address: string; family: 4 | 6 }
export type ResolveHost = (host: string) => Promise<ResolvedTarget[]>;
export const resolveHost: ResolveHost = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map(({ address, family }) => ({
    address, family: family === 6 ? 6 : 4,
  }));

export function localNetworks(): BlockList {
  const networks = new BlockList();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.cidr) continue;
      const [address, bits] = entry.cidr.split("/");
      networks.addSubnet(address, Number(bits), entry.family === "IPv6" ? "ipv6" : "ipv4");
    }
  }
  return networks;
}

export async function resolvePublicTarget(
  host: string,
  allowed: readonly string[],
  resolve: ResolveHost = resolveHost,
  networks: () => BlockList = localNetworks,
): Promise<ResolvedTarget> {
  if (!domainName.safeParse(host).success || !allowed.includes(host)) {
    throw new LocalRefusal("LOCAL_NETWORK_DENIED", "Destination is not locally approved.");
  }
  const answers = await resolve(host);
  const local = networks();
  if (answers.length === 0 || answers.length > 64 || answers.some(({ address, family }) =>
    !publicAddress(address) || isIP(address) !== family ||
    local.check(address, family === 6 ? "ipv6" : "ipv4"))) {
    throw new LocalRefusal("LOCAL_NETWORK_DENIED", "Destination resolves to an unsafe address.");
  }
  return answers[0];
}
