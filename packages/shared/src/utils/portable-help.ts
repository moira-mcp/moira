import { deeplinkGenerators } from "../mcp-clients/index.js";
import { getBaseUrl, getMcpUrl, getStaticArtifactsDomain } from "../config/urls.js";

type DeeplinkGenerator = (mcpUrl: string) => string;

export interface PortableHelpTokenOptions {
  mcpUrl?: string;
  moiraUrl?: string;
  staticDomain?: string;
  deeplinkGenerators?: Readonly<Record<string, DeeplinkGenerator>>;
}

/** Resolve the portable token language shared by runtime help and public documentation. */
export function renderPortableHelpTokens(
  value: string,
  options: PortableHelpTokenOptions = {},
): string {
  const mcpUrl = options.mcpUrl ?? getMcpUrl();
  const generators: Readonly<Record<string, DeeplinkGenerator>> =
    options.deeplinkGenerators ?? deeplinkGenerators;

  return value
    .replace(/\{\{MCP_DEEPLINK:([^{}\s]+)\}\}/g, (token, generatorId: string) => {
      const generator = Object.hasOwn(generators, generatorId)
        ? generators[generatorId]
        : undefined;
      return generator ? generator(mcpUrl) : token;
    })
    .replace(/\{MCP_URL\}/g, mcpUrl)
    .replace(/\{MOIRA_URL\}/g, options.moiraUrl ?? getBaseUrl())
    .replace(/\{STATIC_DOMAIN\}/g, options.staticDomain ?? getStaticArtifactsDomain());
}
