import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { domainName, LocalRefusal } from "./policy.js";
import { publicAddress } from "../../workspace-service/src/public-address.mjs";
export { publicAddress } from "../../workspace-service/src/public-address.mjs";

export interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}
export type ResolveHost = (host: string) => Promise<ResolvedTarget[]>;
export const resolveHost: ResolveHost = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
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
  resolve: ResolveHost = resolveHost,
  networks: () => BlockList = localNetworks,
): Promise<ResolvedTarget> {
  if (!domainName.safeParse(host).success) {
    throw new LocalRefusal("LOCAL_NETWORK_DENIED", "Destination must be a public DNS name.");
  }
  const answers = await resolve(host);
  const local = networks();
  if (
    answers.length === 0 ||
    answers.some(
      ({ address, family }) =>
        !publicAddress(address) ||
        isIP(address) !== family ||
        local.check(address, family === 6 ? "ipv6" : "ipv4"),
    )
  ) {
    throw new LocalRefusal("LOCAL_NETWORK_DENIED", "Destination resolves to an unsafe address.");
  }
  return answers[0];
}
