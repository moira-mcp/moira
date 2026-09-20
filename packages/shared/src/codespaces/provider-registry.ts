import {
  CODESPACE_PROVIDER_CONTRACT_VERSION,
  type CodespaceProviderAdapter,
} from "./resource-types.js";

export class CodespaceProviderRegistry {
  private readonly providers = new Map<string, CodespaceProviderAdapter>();

  register(provider: CodespaceProviderAdapter): void {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(provider.id)) {
      throw new Error("Codespace provider has an invalid identifier");
    }
    if (provider.contractVersion !== CODESPACE_PROVIDER_CONTRACT_VERSION) {
      throw new Error(`Unsupported codespace provider contract: ${provider.contractVersion}`);
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`Codespace provider is already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  require(id: string): CodespaceProviderAdapter {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Codespace provider is not registered: ${id}`);
    return provider;
  }

  list(): CodespaceProviderAdapter[] {
    return [...this.providers.values()];
  }
}
