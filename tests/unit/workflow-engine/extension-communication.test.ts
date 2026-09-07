import { describe, expect, jest, test } from "@jest/globals";
import {
  CommunicationChannelRegistry,
  ExtensionCommunicationChannelReconciler,
  ExtensionInvocationError,
  ExtensionRegistry,
  getActiveCommunicationChannelRegistry,
  getActiveUserCommunicationService,
  initializeExtensionsForProcess,
  TrustedExtensionChannelApprovalService,
  TrustedExtensionChannelEligibilityService,
  UserCommunicationService,
} from "@mcp-moira/workflow-engine";
import type {
  CommunicationConfigurationResolver,
  ExtensionCommunicationChannelRequest,
  ExtensionManifest,
  IDataRepository,
  IExtensionRunnerClient,
  TrustedExtensionChannelApprovalStore,
} from "@mcp-moira/workflow-engine";

function manifest(trustedDelivery = true): ExtensionManifest {
  return {
    apiVersion: "moira.extensions/v1",
    name: "probe",
    version: "1.0.0",
    entrypoint: "index.ts",
    nodes: [],
    settings: [
      { key: "probe.enabled", type: "boolean", label: "Enabled", defaultValue: "true" },
      { key: "probe.destination", type: "string", label: "Destination", required: true },
      { key: "probe.token", type: "encrypted", label: "Token", required: true },
      { key: "probe.unrelated", type: "encrypted", label: "Unrelated" },
    ],
    communicationChannels: [
      {
        id: "probe.notifications",
        title: "Probe notifications",
        capabilities: { text: true, image: false, document: true, trustedDelivery },
        configurationSchema: {
          type: "object",
          required: ["probe.enabled", "probe.destination"],
          additionalProperties: false,
          properties: {
            "probe.enabled": { type: "boolean" },
            "probe.destination": { type: "string", minLength: 1 },
          },
        },
        enabledSetting: "probe.enabled",
        settings: ["probe.enabled", "probe.destination"],
        permissions: { network: ["allowed.example"], secrets: ["probe.token"] },
      },
    ],
  };
}

function runner(overrides: Partial<IExtensionRunnerClient> = {}): IExtensionRunnerClient {
  return {
    invoke: async () => ({ output: {} }),
    checkCommunicationChannel: async () => undefined,
    deliverCommunicationChannel: async () => undefined,
    ...overrides,
  };
}

function configuration(values: Record<string, unknown>): CommunicationConfigurationResolver {
  return { get: async <T>(key: string) => (values[key] ?? null) as T | null };
}

class MemoryApprovalStore implements TrustedExtensionChannelApprovalStore {
  readonly values = new Map<string, string | null>();

  async get(key: string): Promise<{ value: string | null } | null> {
    return this.values.has(key) ? { value: this.values.get(key) ?? null } : null;
  }

  async setValue(key: string, value: string | null): Promise<void> {
    this.values.set(key, value);
  }

  async create(setting: { key: string; value?: string | null }): Promise<void> {
    this.values.set(setting.key, setting.value ?? null);
  }
}

describe("extension communication channel integration", () => {
  test("process initialization adds and removes channels without replacing the shared service", async () => {
    const deliverCommunicationChannel = jest.fn(async () => undefined);
    const client = {
      ...runner({ deliverCommunicationChannel }),
      listExtensions: async () => [manifest()],
    };
    const service = getActiveUserCommunicationService();
    try {
      const initialized = await initializeExtensionsForProcess({
        runnerUrl: "http://runner.invalid",
        createClient: () => client,
        publishSnapshot: false,
      });
      expect(initialized.synced).toBe(true);
      expect(getActiveUserCommunicationService()).toBe(service);
      expect(
        getActiveCommunicationChannelRegistry()
          .list()
          .map((entry) => entry.id),
      ).toContain("probe.notifications");
      const repository = {
        getSetting: async (_userId: string, key: string) =>
          key === "probe.enabled"
            ? true
            : key === "probe.destination"
              ? "team"
              : key === "probe.token"
                ? "secret"
                : null,
      } as unknown as IDataRepository;
      await expect(
        service.deliver({ userId: "process-channel-user", text: "process" }, repository),
      ).resolves.toMatchObject({
        status: "delivered",
        channels: expect.arrayContaining([
          { channelId: "probe.notifications", status: "delivered" },
        ]),
      });
      expect(deliverCommunicationChannel).toHaveBeenCalledTimes(1);
    } finally {
      await initializeExtensionsForProcess({
        runnerUrl: null,
        createClient: () => client,
        publishSnapshot: false,
      });
    }
    expect(
      getActiveCommunicationChannelRegistry()
        .list()
        .map((entry) => entry.id),
    ).not.toContain("probe.notifications");
  });

  test("process initialization rejects an overlong channel identity before reconciliation", async () => {
    const maximumId = `probe.${"a".repeat(122)}`;
    const overlongId = `probe.${"a".repeat(123)}`;
    const client = runner() as IExtensionRunnerClient & {
      listExtensions(): Promise<unknown[]>;
    };
    try {
      client.listExtensions = async () => [
        {
          ...manifest(),
          communicationChannels: [{ ...manifest().communicationChannels![0], id: maximumId }],
        },
      ];
      await expect(
        initializeExtensionsForProcess({
          runnerUrl: "http://runner.invalid",
          createClient: () => client,
          publishSnapshot: false,
        }),
      ).resolves.toMatchObject({ synced: true, registered: ["probe"], rejected: [] });
      expect(
        getActiveCommunicationChannelRegistry()
          .list()
          .map(({ id }) => id),
      ).toContain(maximumId);

      client.listExtensions = async () => [
        {
          ...manifest(),
          communicationChannels: [{ ...manifest().communicationChannels![0], id: overlongId }],
        },
      ];
      await expect(
        initializeExtensionsForProcess({
          runnerUrl: "http://runner.invalid",
          createClient: () => client,
          publishSnapshot: false,
          log: () => undefined,
        }),
      ).resolves.toMatchObject({
        synced: true,
        registered: [],
        rejected: [
          expect.objectContaining({
            manifestName: "probe",
            reasons: expect.arrayContaining([
              expect.stringContaining("channel identity must be at most 128 characters"),
            ]),
          }),
        ],
      });
      expect(
        getActiveCommunicationChannelRegistry()
          .list()
          .map(({ id }) => id),
      ).not.toContain(overlongId);
    } finally {
      await initializeExtensionsForProcess({
        runnerUrl: null,
        createClient: () => client,
        publishSnapshot: false,
      });
    }
  });

  test("reconciles a declared channel into generic fan-out with only its scoped values", async () => {
    const extensionRegistry = new ExtensionRegistry();
    expect(extensionRegistry.register(manifest()).registered).toBe(true);
    const communicationRegistry = new CommunicationChannelRegistry();
    const delivered: ExtensionCommunicationChannelRequest[] = [];
    const client = runner({
      deliverCommunicationChannel: async (request) => delivered.push(request),
    });
    const reconciler = new ExtensionCommunicationChannelReconciler(communicationRegistry);
    expect(reconciler.reconcile(extensionRegistry, client)).toEqual({
      registered: ["probe.notifications"],
      unregistered: [],
    });
    const requestedKeys: string[] = [];
    const repository = {
      getSetting: async (_userId: string, key: string) => {
        requestedKeys.push(key);
        if (key === "probe.enabled") return true;
        if (key === "probe.destination") return "team";
        if (key === "probe.token") return "secret";
        if (key === "probe.unrelated") return "must-not-cross";
        return null;
      },
    } as unknown as IDataRepository;

    const result = await new UserCommunicationService(communicationRegistry).deliver(
      {
        userId: "user-a",
        text: "portable",
        attachment: {
          kind: "document",
          bytes: Uint8Array.of(1, 2),
          filename: "report.bin",
          mimeType: "application/octet-stream",
        },
      },
      repository,
    );

    expect(result).toMatchObject({
      status: "delivered",
      channels: [{ channelId: "probe.notifications", status: "delivered" }],
    });
    expect(requestedKeys).toEqual([
      "probe.enabled",
      "probe.destination",
      "probe.token",
      "probe.enabled",
      "probe.destination",
      "probe.token",
    ]);
    expect(delivered).toEqual([
      expect.objectContaining({
        channelId: "probe.notifications",
        message: expect.objectContaining({ text: "portable" }),
        settings: { "probe.enabled": true, "probe.destination": "team" },
        secrets: { "probe.token": "secret" },
      }),
    ]);
    expect(JSON.stringify(delivered)).not.toContain("user-a");
    expect(JSON.stringify(delivered)).not.toContain("must-not-cross");
    await expect(
      new UserCommunicationService(communicationRegistry).deliver(
        { userId: "trusted-purpose-user", text: "pin", purpose: "trusted" },
        repository,
      ),
    ).resolves.toMatchObject({
      status: "no_configured_channels",
      channels: [{ channelId: "probe.notifications", status: "unsupported" }],
    });
    expect(delivered).toHaveLength(1);

    const disabledRepository = {
      getSetting: async (_userId: string, key: string) =>
        key === "probe.enabled"
          ? false
          : key === "probe.destination"
            ? "team"
            : key === "probe.token"
              ? "secret"
              : null,
    } as unknown as IDataRepository;
    await expect(
      new UserCommunicationService(communicationRegistry).deliver(
        { userId: "user-b", text: "disabled" },
        disabledRepository,
      ),
    ).resolves.toMatchObject({
      status: "no_configured_channels",
      channels: [{ channelId: "probe.notifications", status: "not_configured" }],
    });
    expect(delivered).toHaveLength(1);

    extensionRegistry.unregister("probe");
    expect(reconciler.reconcile(extensionRegistry, client)).toEqual({
      registered: [],
      unregistered: ["probe.notifications"],
    });
    await expect(
      new UserCommunicationService(communicationRegistry).deliver(
        { userId: "user-a", text: "after removal" },
        repository,
      ),
    ).resolves.toMatchObject({ status: "no_configured_channels", channels: [] });
  });

  test("normalizes runner detail to a stable channel failure reason", async () => {
    const extensionRegistry = new ExtensionRegistry();
    extensionRegistry.register(manifest());
    const communicationRegistry = new CommunicationChannelRegistry();
    new ExtensionCommunicationChannelReconciler(communicationRegistry).reconcile(
      extensionRegistry,
      runner({
        deliverCommunicationChannel: async () => {
          throw new ExtensionInvocationError(
            "handler-error",
            "provider echoed secret destination and message",
          );
        },
      }),
    );
    const repository = {
      getSetting: async (_userId: string, key: string) =>
        key === "probe.enabled"
          ? true
          : key === "probe.destination"
            ? "team"
            : key === "probe.token"
              ? "secret"
              : null,
    } as unknown as IDataRepository;

    const result = await new UserCommunicationService(communicationRegistry).deliver(
      { userId: "user", text: "private message" },
      repository,
    );

    expect(result).toMatchObject({
      status: "all_failed",
      channels: [{ channelId: "probe.notifications", status: "failed", reason: "handler_error" }],
    });
    expect(JSON.stringify(result)).not.toContain("destination");
    expect(JSON.stringify(result)).not.toContain("private message");
  });

  test("trusted eligibility requires declaration, persisted approval, health and configuration", async () => {
    const extensionRegistry = new ExtensionRegistry();
    extensionRegistry.register(manifest(true));
    const communicationRegistry = new CommunicationChannelRegistry();
    let healthy = true;
    const client = runner({
      checkCommunicationChannel: async () => {
        if (!healthy) throw new ExtensionInvocationError("runner-unavailable", "down");
      },
    });
    const reconciler = new ExtensionCommunicationChannelReconciler(communicationRegistry);
    reconciler.reconcile(extensionRegistry, client);
    const store = new MemoryApprovalStore();
    const approvals = new TrustedExtensionChannelApprovalService(store);
    const eligibility = new TrustedExtensionChannelEligibilityService(
      extensionRegistry,
      reconciler,
      approvals,
    );
    const valid = configuration({
      "probe.enabled": true,
      "probe.destination": "team",
      "probe.token": "secret",
    });

    await expect(eligibility.evaluate("probe.notifications", valid)).resolves.toMatchObject({
      declared: true,
      approved: false,
      healthy: true,
      configured: true,
      eligible: false,
    });
    const maximumChannelId = `probe.${"a".repeat(122)}`;
    await expect(approvals.setApproved(maximumChannelId, true, "admin")).resolves.toBeUndefined();
    await expect(approvals.isApproved(maximumChannelId)).resolves.toBe(true);
    await expect(approvals.setApproved(`probe.${"a".repeat(123)}`, true, "admin")).rejects.toThrow(
      "identity is invalid",
    );
    await approvals.setApproved("probe.notifications", true, "admin");
    const approvalsAfterRestart = new TrustedExtensionChannelApprovalService(store);
    const afterApproval = new TrustedExtensionChannelEligibilityService(
      extensionRegistry,
      reconciler,
      approvalsAfterRestart,
    );
    await expect(afterApproval.evaluate("probe.notifications", valid)).resolves.toMatchObject({
      declared: true,
      approved: true,
      healthy: true,
      configured: true,
      eligible: true,
    });
    await expect(
      afterApproval.evaluate(
        "probe.notifications",
        configuration({ "probe.enabled": true, "probe.token": "secret" }),
      ),
    ).resolves.toMatchObject({ configured: false, eligible: false });
    healthy = false;
    await expect(afterApproval.evaluate("probe.notifications", valid)).resolves.toMatchObject({
      healthy: false,
      eligible: false,
    });
    healthy = true;
    extensionRegistry.unregister("probe");
    reconciler.reconcile(extensionRegistry, client);
    await expect(afterApproval.evaluate("probe.notifications", valid)).resolves.toMatchObject({
      declared: false,
      approved: true,
      healthy: false,
      configured: false,
      eligible: false,
    });

    const ordinaryRegistry = new ExtensionRegistry();
    ordinaryRegistry.register(manifest(false));
    const ordinaryReconciler = new ExtensionCommunicationChannelReconciler(
      new CommunicationChannelRegistry(),
    );
    ordinaryReconciler.reconcile(ordinaryRegistry, client);
    await expect(
      new TrustedExtensionChannelEligibilityService(
        ordinaryRegistry,
        ordinaryReconciler,
        approvalsAfterRestart,
      ).evaluate("probe.notifications", valid),
    ).resolves.toMatchObject({
      declared: false,
      approved: true,
      healthy: true,
      configured: true,
      eligible: false,
    });
    await approvalsAfterRestart.setApproved("probe.notifications", false, "admin");
    expect(await approvals.isApproved("probe.notifications")).toBe(false);
  });
});
