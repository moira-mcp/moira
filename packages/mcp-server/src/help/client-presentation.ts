import {
  getClientSetupPresentation,
  type ClientCodeBlock,
  type HelpLanguage,
  type McpClient,
} from "@mcp-moira/shared/mcp-clients";

export { getClientSetupPresentation, resolveClientDeeplink } from "@mcp-moira/shared/mcp-clients";
export type {
  ClientCodeBlock,
  ClientSetupPresentation,
  HelpLanguage,
} from "@mcp-moira/shared/mcp-clients";

const codeBlock = ({ language, code, title }: ClientCodeBlock): string =>
  `${title ? `**${title}**\n\n` : ""}\`\`\`${language}\n${code.trim()}\n\`\`\``;

/** Portable help rendering; shared data has no Markdown or server dependencies. */
export function renderClientSetupMarkdown(
  language: HelpLanguage,
  mcpUrl: string,
  clients?: readonly McpClient[],
): string {
  const sections = getClientSetupPresentation(language, mcpUrl, clients).map((presentation) => {
    const lines = [`### ${presentation.label}`, presentation.setup];
    if (presentation.primary) lines.push(codeBlock(presentation.primary));
    if (presentation.deeplink) {
      lines.push(
        `[${presentation.deeplink.label}]({{MCP_DEEPLINK:${presentation.deeplink.generator}}})`,
      );
    }
    lines.push(presentation.authIntro);
    if (presentation.auth) lines.push(codeBlock(presentation.auth));
    if (presentation.alternativeTitle) lines.push(`#### ${presentation.alternativeTitle}`);
    if (presentation.alternativeDescription) lines.push(presentation.alternativeDescription);
    if (presentation.alternative) lines.push(codeBlock(presentation.alternative));
    if (presentation.tokenAuth) {
      lines.push(`#### ${presentation.tokenAuth.sectionTitle}`);
      lines.push(presentation.tokenAuth.description, presentation.tokenAuth.steps);
      lines.push(codeBlock(presentation.tokenAuth.code));
    }
    lines.push(presentation.verification);
    lines.push(`[${presentation.officialDocs.label}](${presentation.officialDocs.url})`);
    return lines.join("\n\n");
  });
  return `${sections.join("\n\n")}\n`;
}
