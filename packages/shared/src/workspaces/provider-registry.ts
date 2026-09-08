import {
  WORKSPACE_PROVIDER_CONTRACT_VERSION,
  type WorkspaceProviderAdapter,
} from "./resource-types.js";

export class WorkspaceProviderRegistry {
  private readonly providers = new Map<string, WorkspaceProviderAdapter>();

  register(provider: WorkspaceProviderAdapter): void {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(provider.id)) {
      throw new Error("Workspace provider has an invalid identifier");
    }
    if (provider.contractVersion !== WORKSPACE_PROVIDER_CONTRACT_VERSION) {
      throw new Error(`Unsupported workspace provider contract: ${provider.contractVersion}`);
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`Workspace provider is already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  require(id: string): WorkspaceProviderAdapter {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Workspace provider is not registered: ${id}`);
    return provider;
  }

  list(): WorkspaceProviderAdapter[] {
    return [...this.providers.values()];
  }
}
