import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { GiB, localPolicySchema, type LocalPolicy } from "../../../packages/local/src/policy.js";
import { LocalRecords, type LocalSpace } from "../../../packages/local/src/space-record.js";
import { PrivateState } from "../../../packages/local/src/private-state.js";

export function localPolicy(root: string): LocalPolicy {
  return localPolicySchema.parse({
    version: 1,
    deviceId: randomUUID(),
    label: "Local integration device",
    enabled: true,
    leaseUntil: Date.now() + 60_000,
    runtime: {
      binary: "/usr/bin/sbx",
      template: `docker.io/test/shell@sha256:${"a".repeat(64)}`,
      storageRoot: join(root, "storage"),
      maxStorageBytes: 32 * GiB,
      cpuCores: 1,
      memoryBytes: GiB,
      dockerBytes: 4 * GiB,
    },
    limits: {
      maxSandboxes: 2,
      maxOperationMs: 60_000,
      maxOutputBytes: 1024 * 1024,
      maxConcurrent: 4,
      maxNetworkBytes: GiB,
      maxNetworkConnections: 4,
    },
    repositories: [
      {
        id: randomUUID(),
        fullName: "owner/project",
        private: false,
        allowPush: false,
        allowDelete: false,
        domains: ["packages.example.com"],
      },
    ],
  });
}

export async function localFixture(state: PrivateState) {
  const policy = localPolicy(state.root);
  await state.write("policy.json", policy);
  const id = randomUUID();
  const space: LocalSpace = {
    id,
    name: `moira-${id.replaceAll("-", "")}`,
    runtimeId: "external-runtime-identity",
    repositoryId: policy.repositories[0].id,
    operationMarker: `moira-${"a".repeat(24)}`,
    ref: "main",
    createdAt: Date.now(),
    lastStartedAt: Date.now(),
    desiredState: "running",
    phase: "usable",
    networkPolicy: "a".repeat(64),
    brokerToken: "b".repeat(64),
    generation: 1,
    failure: null,
  };
  const records = new LocalRecords(state);
  await records.put(space);
  return {
    policy,
    space,
    records,
    authorization: `Basic ${Buffer.from(`${id}:${space.brokerToken}`).toString("base64")}`,
  };
}
