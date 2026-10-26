/**
 * Quick Start Card Component
 * Shows per-client MCP setup instructions with tabbed interface
 */

import React, { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Check, BookOpen, ExternalLink, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  getClientSetupPresentation,
  resolveClientDeeplink,
  type ClientSetupPresentation,
} from "@mcp-moira/shared/mcp-clients";
import { useFeatures } from "@/hooks/useFeatures";
import { localizedDocsPath } from "@/lib/docs-path";
import { HidePanelButton } from "./onboarding/HidePanelButton";
import { usePanelVisible } from "./onboarding/beginnerPanels";
import { guideAnchor } from "@/guides/anchors";

/**
 * MCP URL baked into the bundle at build time from MOIRA_HOST (webpack
 * DefinePlugin). Correct for our hosted (saas) deploy, where the build host
 * matches the serving host. Used as the saas value and as the loading fallback.
 */
const BAKED_MCP_URL = process.env.MCP_URL as string;

/**
 * Resolve the MCP URL to display, gated by deployment mode (pure, unit-tested):
 * - self-host: use the runtime URL the server resolved from its own host config
 *   (correct on whatever host/port the instance runs on); fall back to the baked
 *   value while the runtime value is still loading / unavailable.
 * - saas (or mode not yet loaded): keep the build-time-baked value, so our
 *   hosted deploy is unchanged and nothing flashes a wrong URL before load.
 */
export function resolveMcpUrl(
  deploymentMode: "self-host" | "saas" | null,
  runtimeMcpUrl: string | null,
  bakedMcpUrl: string,
): string {
  if (deploymentMode === "self-host") {
    return runtimeMcpUrl ?? bakedMcpUrl;
  }
  return bakedMcpUrl;
}

function useMcpUrl(): string {
  const { deploymentMode, mcpUrl } = useFeatures();
  return resolveMcpUrl(deploymentMode, mcpUrl, BAKED_MCP_URL);
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied
    }
  }, [text]);

  return (
    <Button variant="ghost" size="sm" onClick={handleCopy} className="h-7 px-2 text-xs">
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 mr-1 text-success" />
          {t("pages.dashboard.quickStart.copied")}
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5 mr-1" />
          {t("pages.dashboard.quickStart.copy")}
        </>
      )}
    </Button>
  );
}

function CodeBlock({ code, title }: { code: string; title?: string }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {title && (
        <div className="flex items-center justify-between bg-muted/50 px-3 py-1.5 border-b border-border">
          <span className="text-xs font-medium text-muted-foreground">{title}</span>
          <CopyButton text={code} />
        </div>
      )}
      <pre className="p-3 overflow-x-auto text-sm font-mono bg-muted/30">
        <code>{code}</code>
      </pre>
      {!title && (
        <div className="flex justify-end px-2 py-1 bg-muted/30 border-t border-border">
          <CopyButton text={code} />
        </div>
      )}
    </div>
  );
}

function CollapsibleSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown
          className={`h-4 w-4 transition-transform ${open ? "rotate-0" : "-rotate-90"}`}
        />
        {title}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

function ClientPanel({
  presentation,
  mcpUrl,
}: {
  presentation: ClientSetupPresentation;
  mcpUrl: string;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground whitespace-pre-line">{presentation.setup}</p>
      {presentation.primary && (
        <CodeBlock code={presentation.primary.code} title={presentation.primary.title} />
      )}
      {presentation.deeplink && (
        <a
          href={resolveClientDeeplink(presentation, mcpUrl)}
          aria-label={presentation.deeplink.ariaLabel}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground font-medium rounded-lg hover:bg-primary/90 transition-colors text-sm"
        >
          <ExternalLink className="h-4 w-4" />
          {presentation.deeplink.label}
        </a>
      )}
      <p className="text-sm text-muted-foreground whitespace-pre-line">{presentation.authIntro}</p>
      {presentation.auth && (
        <CodeBlock code={presentation.auth.code} title={presentation.auth.title} />
      )}
      {presentation.alternative && (
        <CollapsibleSection
          title={
            presentation.alternativeTitle ?? presentation.alternative.title ?? presentation.label
          }
        >
          {presentation.alternativeDescription && (
            <p className="text-sm text-muted-foreground whitespace-pre-line mb-2">
              {presentation.alternativeDescription}
            </p>
          )}
          <CodeBlock code={presentation.alternative.code} title={presentation.alternative.title} />
        </CollapsibleSection>
      )}
      {presentation.tokenAuth && (
        <CollapsibleSection title={presentation.tokenAuth.sectionTitle}>
          <p className="text-sm text-muted-foreground mb-2">{presentation.tokenAuth.description}</p>
          <p className="text-sm text-muted-foreground whitespace-pre-line mb-2">
            {presentation.tokenAuth.steps}
          </p>
          <CodeBlock
            code={presentation.tokenAuth.code.code}
            title={presentation.tokenAuth.code.title}
          />
        </CollapsibleSection>
      )}
      <p className="text-sm text-muted-foreground whitespace-pre-line">
        {presentation.verification}
      </p>
      <a
        href={presentation.officialDocs.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        {presentation.officialDocs.label}
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

export const QuickStartCard: React.FC = () => {
  const { t, i18n } = useTranslation();
  const mcpUrl = useMcpUrl();
  // A beginner panel: its reader can hide it for good. Hooks run before the early return.
  const visible = usePanelVisible("quick-start");

  const getDocsPath = () => localizedDocsPath("/docs/getting-started/quickstart/", i18n.language);

  const presentations = useMemo(
    () =>
      getClientSetupPresentation(
        i18n.language.toLowerCase().startsWith("ru") ? "ru" : "en",
        mcpUrl,
      ),
    [i18n.language, mcpUrl],
  );

  if (!visible) return null;
  return (
    <div
      className="bg-card border border-border rounded-lg p-6 mb-8"
      data-testid="quick-start-card"
      {...guideAnchor("home.connect")}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-semibold">{t("pages.dashboard.quickStart.title")}</h2>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={getDocsPath()}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {t("pages.dashboard.quickStart.documentation")}
          </a>
          <HidePanelButton panel="quick-start" />
        </div>
      </div>

      <p className="text-muted-foreground mb-4 text-sm">
        {t("pages.dashboard.quickStart.description")}
      </p>

      <Tabs defaultValue={presentations[0].client.id}>
        <TabsList className="w-full flex-wrap h-auto gap-0.5 group-data-[orientation=horizontal]/tabs:h-auto">
          {presentations.map(({ client, label }) => (
            <TabsTrigger key={client.id} value={client.id} className="text-xs px-2.5 py-1.5">
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {presentations.map((presentation) => (
          <TabsContent key={presentation.client.id} value={presentation.client.id} className="mt-4">
            <ClientPanel presentation={presentation} mcpUrl={mcpUrl} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
};
