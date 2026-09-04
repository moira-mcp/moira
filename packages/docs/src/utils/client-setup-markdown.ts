import { mcpClients, tokenConfigGenerators } from "@mcp-moira/shared/mcp-clients";
import type { McpClient } from "@mcp-moira/shared/mcp-clients";
import { createT, type Language } from "../i18n-server";

const codeBlock = (language: string, value: string, title?: string): string =>
  `${title ? `**${title}**\n\n` : ""}\`\`\`${language}\n${value.trim()}\n\`\`\``;

export function renderClientSetupMarkdown(
  lang: Language,
  mcpUrl: string,
  clients: readonly McpClient[] = mcpClients,
): string {
  const t = createT(lang);
  const text = (client: McpClient, field: string): string =>
    t(`quickStart.tabs.${client.id}.${field}`).replace(/\{\{mcpUrl\}\}/g, mcpUrl);
  const tokenText = (field: string): string => t(`quickStart.tokenAuth.${field}`);
  const sections: string[] = [];

  for (const client of clients) {
    const lines = [`### ${text(client, "label")}`];

    if (client.setupType === "gui" || client.setupType === "config") {
      lines.push(text(client, "description"));
      lines.push(
        codeBlock(client.configLanguage, text(client, "content"), client.setup.primaryTitle),
      );
    } else {
      lines.push(`**${text(client, "recommended")}**`);

      if (client.setupType === "cli") {
        lines.push(
          codeBlock(
            client.configLanguage,
            text(client, "primaryContent"),
            client.setup.primaryTitle,
          ),
        );
      } else {
        const deeplink = client.deeplinkGenerator
          ? `{{MCP_DEEPLINK:${client.deeplinkGenerator}}}`
          : undefined;
        if (deeplink) lines.push(`[${text(client, "deeplinkButton")}](${deeplink})`);
      }

      if (client.setup.auth) {
        lines.push(text(client, "authIntro"));
        lines.push(
          codeBlock(
            client.setup.auth.language,
            text(client, "authContent"),
            client.setup.auth.title,
          ),
        );
      }

      if (client.setup.alternative) {
        lines.push(`#### ${text(client, "alternativeTitle")}`);
        lines.push(
          codeBlock(
            client.setup.alternative.language,
            text(client, "alternativeContent"),
            client.setup.alternative.title,
          ),
        );
      }
    }

    if (client.setup.tokenAuth) {
      lines.push(`#### ${tokenText("sectionTitle")}`);
      lines.push(tokenText("description"));
      lines.push(tokenText("steps"));
      lines.push(
        codeBlock(
          client.setup.tokenAuth.language,
          tokenConfigGenerators[client.setup.tokenAuth.generator](mcpUrl),
          client.setup.tokenAuth.title,
        ),
      );
    }

    sections.push(lines.join("\n\n"));
  }

  return `${sections.join("\n\n")}\n`;
}
