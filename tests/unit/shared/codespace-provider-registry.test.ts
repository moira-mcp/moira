import { describe, expect, test } from "@jest/globals";
import {
  CODESPACE_PROVIDER_CONTRACT_VERSION,
  CodespaceProviderRegistry,
  type CodespaceProviderAdapter,
} from "@mcp-moira/shared";

function provider(id: string): CodespaceProviderAdapter {
  return {
    id,
    contractVersion: CODESPACE_PROVIDER_CONTRACT_VERSION,
    capabilities: {
      disposable: true,
      persistent: true,
      exactLifecycle: true,
      personalBillingOnly: true,
      connector: "github-cli-ssh",
    },
    health: async () => ({ state: "available", reason: null }),
    getIdentity: async () => ({ id: "1", login: "owner" }),
    listMachines: async () => [],
    create: async () => ({ outcome: "rejected", reason: "unused" }),
    listOwned: async () => [],
    getExact: async () => null,
    startExact: async () => "absent" as const,
    stopExact: async () => "absent" as const,
    deleteExact: async () => "absent",
    probeConnector: async () => undefined,
    guidance: () => ({ links: [], instructions: {} }),
  };
}

describe("CodespaceProviderRegistry", () => {
  test("registers reviewed versioned adapters and rejects duplicate or incompatible entries", () => {
    const registry = new CodespaceProviderRegistry();
    const adapter = provider("github-codespaces");
    registry.register(adapter);
    expect(registry.require(adapter.id)).toBe(adapter);
    expect(registry.list()).toEqual([adapter]);
    expect(() => registry.register(provider(adapter.id))).toThrow(/already registered/);
    expect(() =>
      registry.register({
        ...provider("future-provider"),
        contractVersion: 2 as typeof CODESPACE_PROVIDER_CONTRACT_VERSION,
      }),
    ).toThrow(/Unsupported/);
    expect(() => registry.register(provider("../unsafe"))).toThrow(/invalid identifier/);
  });
});
