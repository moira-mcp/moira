import {
  configGenerators,
  deeplinkGenerators,
  mcpClients,
  tokenConfigGenerators,
} from "@mcp-moira/shared/mcp-clients";
import type { ConfigLanguage, DeeplinkGeneratorId, McpClient } from "@mcp-moira/shared/mcp-clients";

import en from "./client-presentation.en.json";
import ru from "./client-presentation.ru.json";

export type HelpLanguage = "en" | "ru";

interface ClientPresentationTexts {
  tabs: Record<string, Record<string, string>>;
  tokenAuth: Record<string, string>;
}

export interface ClientCodeBlock {
  code: string;
  language: ConfigLanguage;
  title?: string;
}

export interface ClientSetupPresentation {
  client: McpClient;
  label: string;
  description?: string;
  recommended?: string;
  primary?: ClientCodeBlock;
  authIntro?: string;
  auth?: ClientCodeBlock;
  alternativeTitle?: string;
  alternative?: ClientCodeBlock;
  deeplinkButton?: string;
  deeplinkAriaLabel?: string;
  deeplinkGenerator?: DeeplinkGeneratorId;
  tokenAuth?: {
    sectionTitle: string;
    description: string;
    steps: string;
    code: ClientCodeBlock;
  };
}

const texts: Record<HelpLanguage, ClientPresentationTexts> = { en, ru };

function text(language: HelpLanguage, client: McpClient, field: string): string {
  const localized = texts[language].tabs[client.id]?.[field];
  if (localized !== undefined) return localized;
  if (field === "label") return client.name;
  if (field === "description") return client.description;
  return `quickStart.tabs.${client.id}.${field}`;
}

function replaceMcpUrl(value: string, mcpUrl: string): string {
  return value.replace(/\{\{mcpUrl\}\}/g, mcpUrl);
}

export function getClientSetupPresentation(
  language: HelpLanguage,
  mcpUrl: string,
  clients: readonly McpClient[] = mcpClients,
): readonly ClientSetupPresentation[] {
  return clients.map((client) => {
    const primaryCode = client.setup.primaryGenerator
      ? configGenerators[client.setup.primaryGenerator](mcpUrl)
      : replaceMcpUrl(text(language, client, "content"), mcpUrl);
    const alternativeCode = client.setup.alternative?.generator
      ? configGenerators[client.setup.alternative.generator](mcpUrl)
      : client.setup.alternative
        ? replaceMcpUrl(text(language, client, "alternativeContent"), mcpUrl)
        : undefined;

    return {
      client,
      label: text(language, client, "label"),
      description:
        client.setupType === "gui" || client.setupType === "config"
          ? text(language, client, "description")
          : undefined,
      recommended:
        client.setupType === "cli" || client.setupType === "deeplink"
          ? text(language, client, "recommended")
          : undefined,
      primary:
        client.setupType === "deeplink"
          ? undefined
          : {
              code: primaryCode,
              language: client.configLanguage,
              title: client.setup.primaryTitle,
            },
      authIntro: client.setup.auth ? text(language, client, "authIntro") : undefined,
      auth: client.setup.auth
        ? {
            code: replaceMcpUrl(text(language, client, "authContent"), mcpUrl),
            language: client.setup.auth.language,
            title: client.setup.auth.title,
          }
        : undefined,
      alternativeTitle: client.setup.alternative
        ? text(language, client, "alternativeTitle")
        : undefined,
      alternative:
        client.setup.alternative && alternativeCode !== undefined
          ? {
              code: alternativeCode,
              language: client.setup.alternative.language,
              title: client.setup.alternative.title,
            }
          : undefined,
      deeplinkButton: client.deeplinkGenerator
        ? text(language, client, "deeplinkButton")
        : undefined,
      deeplinkAriaLabel: client.deeplinkGenerator ? text(language, client, "ariaLabel") : undefined,
      deeplinkGenerator: client.deeplinkGenerator,
      tokenAuth: client.setup.tokenAuth
        ? {
            sectionTitle: texts[language].tokenAuth.sectionTitle,
            description: texts[language].tokenAuth.description,
            steps: texts[language].tokenAuth.steps,
            code: {
              code: tokenConfigGenerators[client.setup.tokenAuth.generator](mcpUrl),
              language: client.setup.tokenAuth.language,
              title: client.setup.tokenAuth.title,
            },
          }
        : undefined,
    };
  });
}

export function resolveClientDeeplink(
  presentation: Pick<ClientSetupPresentation, "deeplinkGenerator">,
  mcpUrl: string,
): string | undefined {
  return presentation.deeplinkGenerator
    ? deeplinkGenerators[presentation.deeplinkGenerator](mcpUrl)
    : undefined;
}

const codeBlock = ({ language, code, title }: ClientCodeBlock): string =>
  `${title ? `**${title}**\n\n` : ""}\`\`\`${language}\n${code.trim()}\n\`\`\``;

export function renderClientSetupMarkdown(
  language: HelpLanguage,
  mcpUrl: string,
  clients: readonly McpClient[] = mcpClients,
): string {
  const sections = getClientSetupPresentation(language, mcpUrl, clients).map((presentation) => {
    const lines = [`### ${presentation.label}`];

    if (presentation.description) lines.push(presentation.description);
    if (presentation.recommended) lines.push(`**${presentation.recommended}**`);
    if (presentation.primary) lines.push(codeBlock(presentation.primary));
    if (presentation.deeplinkGenerator && presentation.deeplinkButton) {
      lines.push(
        `[${presentation.deeplinkButton}]({{MCP_DEEPLINK:${presentation.deeplinkGenerator}}})`,
      );
    }
    if (presentation.authIntro) lines.push(presentation.authIntro);
    if (presentation.auth) lines.push(codeBlock(presentation.auth));
    if (presentation.alternativeTitle) lines.push(`#### ${presentation.alternativeTitle}`);
    if (presentation.alternative) lines.push(codeBlock(presentation.alternative));
    if (presentation.tokenAuth) {
      lines.push(`#### ${presentation.tokenAuth.sectionTitle}`);
      lines.push(presentation.tokenAuth.description, presentation.tokenAuth.steps);
      lines.push(codeBlock(presentation.tokenAuth.code));
    }

    return lines.join("\n\n");
  });

  return `${sections.join("\n\n")}\n`;
}
