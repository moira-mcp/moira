import { describe, expect, test } from "@jest/globals";
import { BlockList } from "node:net";
import { GiB, localPolicySchema, requireLocalGrant, requireRef } from "../../../packages/local/src/policy.js";
import { publicAddress, resolvePublicTarget } from "../../../packages/local/src/network.js";

const repositoryId = "3777b02c-473b-4aec-90b4-2319e03c0405";
const rawPolicy = {
  version: 1, deviceId: "3c5f7b3b-24e3-44c5-8f18-72bb137cb02b", label: "Local test", enabled: true, leaseUntil: 60_000,
  runtime: { binary: "/usr/bin/sbx", template: `docker.io/test/shell@sha256:${"a".repeat(64)}`, storageRoot: "/local/storage", maxStorageBytes: 32 * GiB, cpuCores: 2, memoryBytes: 2 * GiB, dockerBytes: 4 * GiB },
  limits: { maxSandboxes: 2, maxOperationMs: 300_000, maxOutputBytes: 1024 * 1024, maxConcurrent: 4, maxNetworkBytes: GiB, maxNetworkConnections: 4 },
  repositories: [{ id: repositoryId, fullName: "owner/project", private: true, allowPush: false, domains: ["registry.npmjs.org"] }],
};

describe("local authority remains independent of cloud assertions", () => {
  test("only a locally approved repository inside the work lease is admitted", () => {
    const policy = localPolicySchema.parse(rawPolicy);
    expect(requireLocalGrant(policy, repositoryId, 1000).fullName).toBe("owner/project");
    expect(() => requireLocalGrant(policy, "7916f308-85bf-4619-ab52-f27f2cb40a39", 1000)).toThrow("Approve this repository locally");
    expect(() => requireLocalGrant({ ...policy, enabled: false }, repositoryId, 1000)).toThrow("Enable work");
    expect(() => requireLocalGrant(policy, repositoryId, 60_001)).toThrow("Renew the work lease");
    expect(() => requireLocalGrant({ ...policy, leaseUntil: 1e12 }, repositoryId, 1000)).toThrow("Renew the work lease");
  });
  test("unknown fields cannot introduce host execution, mounts or approval", () => {
    expect(localPolicySchema.safeParse({ ...rawPolicy, approved: true }).success).toBe(false);
    expect(localPolicySchema.safeParse({ ...rawPolicy, runtime: { ...rawPolicy.runtime, mounts: ["/home"] } }).success).toBe(false);
    expect(localPolicySchema.safeParse({ ...rawPolicy, repositories: [...rawPolicy.repositories, ...rawPolicy.repositories] }).success).toBe(false);
    expect(localPolicySchema.safeParse({ ...rawPolicy, runtime: { ...rawPolicy.runtime, template: "docker.io/test/shell:latest" } }).success).toBe(false);
  });
  test.each(["--upload-pack=sh", "main\ncommand", "../main", "main:other", "main\\bad", "a@{b", "head "])("ref %s cannot become a Git option or traversal", (ref) => {
    expect(() => requireRef(ref)).toThrow();
  });
  test("ordinary named branches and immutable commits remain usable", () => {
    expect(requireRef("feature/local-runtime")).toBe("feature/local-runtime");
    expect(requireRef("a".repeat(40))).toBe("a".repeat(40));
  });
});

describe("public destination resolution", () => {
  test.each(["127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254", "172.31.1.1", "192.168.1.1", "192.0.2.3", "198.19.1.1", "198.51.100.1", "203.0.113.1", "255.255.255.255", "::", "::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:7f00:1::", "2001:db8::1", "3fff::1", "fd00::1", "fe80::1%en0", "not-an-ip"])("denies special or translated address %s", (address) => {
    expect(publicAddress(address)).toBe(false);
  });
  test.each(["8.8.8.8", "140.82.112.3", "2606:4700:4700::1111"])("admits public address %s", (address) => {
    expect(publicAddress(address)).toBe(true);
  });
  test("pins a public answer but rejects mixed private answers and the host's own public subnet", async () => {
    const lookup = async () => [{ address: "140.82.112.3", family: 4 as const }];
    expect(await resolvePublicTarget("github.com", ["github.com"], lookup, () => new BlockList())).toEqual({ address: "140.82.112.3", family: 4 });
    await expect(resolvePublicTarget("github.com", ["github.com"], async () => [...await lookup(), { address: "127.0.0.1", family: 4 }])).rejects.toThrow("unsafe address");
    const local = new BlockList();
    local.addSubnet("140.82.112.0", 24, "ipv4");
    await expect(resolvePublicTarget("github.com", ["github.com"], lookup, () => local)).rejects.toThrow("unsafe address");
    await expect(resolvePublicTarget("github.com.attacker.example", ["github.com"], lookup)).rejects.toThrow("not locally approved");
  });
});
