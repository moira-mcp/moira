/**
 * Quick Start Card Component
 * Shows per-client MCP setup instructions with tabbed interface
 */

import React, { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Check, BookOpen, ExternalLink, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { mcpClients, configGenerators, deeplinkGenerators } from "@mcp-moira/shared/mcp-clients";
import type { McpClient } from "@mcp-moira/shared/mcp-clients";
import { useFeatures } from "@/hooks/useFeatures";

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

function ClientPanel({ client, mcpUrl }: { client: McpClient; mcpUrl: string }) {
  const { t } = useTranslation();
  const ct = useCallback(
    (field: string) => t(`pages.dashboard.quickStart.clients.${client.id}.${field}`),
    [t, client.id],
  );

  const { setup, setupType } = client;

  if (setupType === "gui") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground whitespace-pre-line">{ct("description")}</p>
      </div>
    );
  }

  if (setupType === "config") {
    const code = setup.primaryGenerator ? configGenerators[setup.primaryGenerator](mcpUrl) : "";
    return (
      <div className="space-y-3">
        <CodeBlock code={code} title={setup.primaryTitle} />
      </div>
    );
  }

  if (setupType === "cli") {
    const primaryCode = setup.primaryGenerator
      ? configGenerators[setup.primaryGenerator](mcpUrl)
      : "";
    const altCode = setup.alternative?.generator
      ? configGenerators[setup.alternative.generator](mcpUrl)
      : "";

    return (
      <div className="space-y-3">
        <CodeBlock code={primaryCode} title={setup.primaryTitle} />
        {setup.auth && (
          <>
            <p className="text-sm text-muted-foreground">{ct("authIntro")}</p>
            <CodeBlock code={ct("authContent")} title={setup.auth.title} />
          </>
        )}
        {setup.alternative && altCode && (
          <CollapsibleSection title={ct("alternativeTitle")}>
            <CodeBlock code={altCode} title={setup.alternative.title} />
          </CollapsibleSection>
        )}
      </div>
    );
  }

  if (setupType === "deeplink") {
    const deeplinkUrl = client.deeplinkGenerator
      ? deeplinkGenerators[client.deeplinkGenerator](mcpUrl)
      : "";
    const altCode = setup.alternative?.generator
      ? configGenerators[setup.alternative.generator](mcpUrl)
      : "";

    return (
      <div className="space-y-3">
        <a
          href={deeplinkUrl}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground font-medium rounded-lg hover:bg-primary/90 transition-colors text-sm"
        >
          <ExternalLink className="h-4 w-4" />
          {ct("deeplinkButton")}
        </a>
        {setup.auth && (
          <>
            <p className="text-sm text-muted-foreground">{ct("authIntro")}</p>
            <CodeBlock code={ct("authContent")} title={setup.auth.title} />
          </>
        )}
        {setup.alternative && altCode && (
          <CollapsibleSection title={ct("alternativeTitle")}>
            <CodeBlock code={altCode} title={setup.alternative.title} />
          </CollapsibleSection>
        )}
      </div>
    );
  }

  return null;
}

export const QuickStartCard: React.FC = () => {
  const { t, i18n } = useTranslation();
  const mcpUrl = useMcpUrl();

  const getDocsPath = () => {
    const lang = i18n.language?.substring(0, 2);
    return lang === "ru"
      ? "/ru/docs/getting-started/quickstart/"
      : "/docs/getting-started/quickstart/";
  };

  const defaultClient = useMemo(() => mcpClients[0].id, []);

  return (
    <div className="bg-card border border-border rounded-lg p-6 mb-8">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-semibold">{t("pages.dashboard.quickStart.title")}</h2>
        </div>
        <a
          href={getDocsPath()}
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          {t("pages.dashboard.quickStart.documentation")}
        </a>
      </div>

      <p className="text-muted-foreground mb-4 text-sm">
        {t("pages.dashboard.quickStart.description")}
      </p>

      <Tabs defaultValue={defaultClient}>
        <TabsList className="w-full flex-wrap h-auto gap-0.5">
          {mcpClients.map((client) => (
            <TabsTrigger key={client.id} value={client.id} className="text-xs px-2.5 py-1.5">
              {client.name}
            </TabsTrigger>
          ))}
        </TabsList>

        {mcpClients.map((client) => (
          <TabsContent key={client.id} value={client.id} className="mt-4">
            <ClientPanel client={client} mcpUrl={mcpUrl} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
};
