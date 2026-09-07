import { getActiveCommunicationChannelRegistry } from "../services/user-communication-provider.js";
import type { CommunicationChannelRegistry } from "../services/user-communication.js";
import { ExtensionCommunicationChannelAdapter } from "./extension-communication-channel.js";
import type { ExtensionRegistry } from "./extension-registry.js";
import type { IExtensionRunnerClient } from "./extension-runner-client.js";

/** Keeps one communication registry aligned with the current extension registry in place. */
export class ExtensionCommunicationChannelReconciler {
  private readonly installed = new Map<
    string,
    {
      identity: string;
      client: IExtensionRunnerClient;
      adapter: ExtensionCommunicationChannelAdapter;
    }
  >();

  constructor(private readonly target: CommunicationChannelRegistry) {}

  reconcile(
    registry: ExtensionRegistry,
    client: IExtensionRunnerClient,
  ): { registered: string[]; unregistered: string[] } {
    const desired = new Map(
      registry.communicationChannels().map((registered) => {
        const adapter = new ExtensionCommunicationChannelAdapter(registered, client);
        return [adapter.id, adapter] as const;
      }),
    );
    const unregistered: string[] = [];
    const registered: string[] = [];

    for (const [id, current] of this.installed) {
      const next = desired.get(id);
      if (next && next.identity() === current.identity && current.client === client) continue;
      this.target.unregister(id);
      this.installed.delete(id);
      unregistered.push(id);
    }

    for (const [id, adapter] of desired) {
      if (this.installed.has(id)) continue;
      this.target.register(adapter);
      this.installed.set(id, { identity: adapter.identity(), client, adapter });
      registered.push(id);
    }

    return { registered, unregistered };
  }

  clear(): string[] {
    const removed: string[] = [];
    for (const id of this.installed.keys()) {
      this.target.unregister(id);
      removed.push(id);
    }
    this.installed.clear();
    return removed;
  }

  get(channelId: string): ExtensionCommunicationChannelAdapter | undefined {
    return this.installed.get(channelId)?.adapter;
  }
}

const activeExtensionCommunicationChannels = new ExtensionCommunicationChannelReconciler(
  getActiveCommunicationChannelRegistry(),
);

export function getActiveExtensionCommunicationChannelReconciler(): ExtensionCommunicationChannelReconciler {
  return activeExtensionCommunicationChannels;
}
