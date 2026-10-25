import { mcpClients } from "./clients.js";
import { configGenerators, deeplinkGenerators, tokenConfigGenerators } from "./config.js";
import type { ConfigLanguage, DeeplinkGeneratorId, McpClient } from "./types.js";
import en from "./presentation.en.js";
import ru from "./presentation.ru.js";

export type HelpLanguage = "en" | "ru";

interface ClientPresentationTexts {
  common: Record<string, string>;
  tabs: Record<string, Record<string, string>>;
  tokenAuth: Record<string, string>;
}

export interface ClientCodeBlock {
  code: string;
  language: ConfigLanguage;
  title?: string;
}

/** Plain localized prose and native snippets, independent of any rendering framework. */
export interface ClientSetupPresentation {
  client: McpClient;
  label: string;
  setup: string;
  authIntro: string;
  verification: string;
  officialDocs: { label: string; url: string };
  primary?: ClientCodeBlock;
  auth?: ClientCodeBlock;
  alternativeTitle?: string;
  alternativeDescription?: string;
  alternative?: ClientCodeBlock;
  deeplink?: { generator: DeeplinkGeneratorId; label: string; ariaLabel: string };
  tokenAuth?: {
    sectionTitle: string;
    description: string;
    steps: string;
    code: ClientCodeBlock;
  };
}

const texts: Record<HelpLanguage, ClientPresentationTexts> = { en, ru };

export function getClientSetupPresentation(
  language: HelpLanguage,
  mcpUrl: string,
  clients: readonly McpClient[] = mcpClients,
): readonly ClientSetupPresentation[] {
  const { common, tabs, tokenAuth } = texts[language];
  return clients.map((client) => {
    const localized = tabs[client.id] ?? {};
    const text = (field: string, fallback = ""): string =>
      (localized[field] ?? fallback).replace(/\{\{mcpUrl\}\}/g, () => mcpUrl);
    const authContent = text("authContent");
    const primary = client.setup.primaryGenerator
      ? {
          code: configGenerators[client.setup.primaryGenerator](mcpUrl),
          language: client.configLanguage,
          title: client.setup.primaryTitle,
        }
      : client.setupType === "gui"
        ? { code: mcpUrl, language: "text" as const, title: common.serverUrl }
        : undefined;
    const alternative = client.setup.alternative;
    return {
      client,
      label: text("label", client.name),
      setup: text("setup", client.description),
      authIntro: text("authIntro", common.fallbackAuth),
      verification: [text("verification"), common.verificationSuffix].filter(Boolean).join(" "),
      officialDocs: { label: common.officialDocs, url: client.url },
      primary,
      auth:
        client.setup.auth && authContent
          ? {
              code: authContent,
              language: client.setup.auth.language,
              title: client.setup.auth.title,
            }
          : undefined,
      alternativeTitle: alternative ? text("alternativeTitle", common.alternativeTitle) : undefined,
      alternativeDescription: text("alternativeDescription") || undefined,
      alternative: alternative
        ? {
            code: alternative.generator
              ? configGenerators[alternative.generator](mcpUrl)
              : text("alternativeContent"),
            language: alternative.language,
            title: alternative.title,
          }
        : undefined,
      deeplink: client.deeplinkGenerator
        ? {
            generator: client.deeplinkGenerator,
            label: text("deeplinkButton", client.name),
            ariaLabel: text("ariaLabel", client.name),
          }
        : undefined,
      tokenAuth: client.setup.tokenAuth
        ? {
            sectionTitle: tokenAuth.sectionTitle,
            description: tokenAuth.description,
            steps: text("tokenSteps", tokenAuth.steps),
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
  presentation: Pick<ClientSetupPresentation, "deeplink">,
  mcpUrl: string,
): string | undefined {
  return presentation.deeplink
    ? deeplinkGenerators[presentation.deeplink.generator](mcpUrl)
    : undefined;
}
