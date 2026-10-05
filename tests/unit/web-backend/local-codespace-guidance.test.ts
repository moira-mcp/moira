import { describe, expect, it } from "@jest/globals";
import type { CodespaceResourceRepository } from "@mcp-moira/shared";
import { LocalCodespaceProvider } from "../../../packages/web-backend/src/services/local-codespace-provider.js";
import type { LocalCodespaceRelay } from "../../../packages/web-backend/src/services/local-codespace-relay.js";
import { localCodespaceSettingsUrl } from "../../../packages/web-backend/src/services/local-codespace-services.js";

describe("local codespace setup guidance", () => {
  it.each([undefined, "/", "app///", "/app/"])(
    "links to the local card under app prefix %s",
    (prefix) => {
      const url = new URL(localCodespaceSettingsUrl("https://moira.example", prefix ?? "/"));
      expect(url.origin).toBe("https://moira.example");
      expect(url.pathname).toBe(prefix && prefix !== "/" ? "/app/settings" : "/settings");
      expect(url.hash).toBe("#integrations-local");
      expect(url.search).toBe("");
    },
  );
  it("explains instance enablement and local enrollment without suggesting a policy override", () => {
    const provider = new LocalCodespaceProvider(
      {} as LocalCodespaceRelay,
      {} as CodespaceResourceRepository,
      "https://moira.example/app/settings#integrations-local",
    );
    const guidance = provider.guidance();
    expect(guidance.instructions).toMatchObject({
      instance_disabled: expect.stringMatching(/administrator.*enable.*Connect Moira Local/),
      connection_required: expect.stringContaining("approve the pairing"),
    });
    expect(guidance.links).toEqual([
      {
        id: "settings",
        label: "Local devices",
        url: "https://moira.example/app/settings#integrations-local",
      },
    ]);
  });
});
