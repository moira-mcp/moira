import React from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { SettingsEditor, type SettingDefinition } from "./SettingsEditor";

export type CommunicationChannelState = "ready" | "disabled" | "incomplete" | "unavailable";

export interface CommunicationChannelDescriptor {
  id: string;
  title: string;
  description: string | null;
  origin: "builtin" | "extension";
  extensionName: string | null;
  extensionVersion: string | null;
  settingKeys: string[];
  helpUrl: string | null;
  capabilities: { text: boolean; image: boolean; document: boolean };
  enabled: boolean;
  configured: boolean;
  available: boolean;
  state: CommunicationChannelState;
  trustedDelivery: { declared: boolean; approved: boolean; eligible: boolean } | null;
}

interface CommunicationChannelCardProps {
  channel: CommunicationChannelDescriptor;
  definitions: SettingDefinition[];
  values: Record<string, unknown>;
  testing: boolean;
  onSave(key: string, value: unknown): Promise<void>;
  onTest(channel: CommunicationChannelDescriptor): Promise<void>;
}

export function CommunicationChannelCard({
  channel,
  definitions,
  values,
  testing,
  onSave,
  onTest,
}: CommunicationChannelCardProps) {
  const { t } = useTranslation();
  const capabilities = [
    channel.capabilities.text && t("pages.settings.channels.capabilities.text"),
    channel.capabilities.image && t("pages.settings.channels.capabilities.images"),
    channel.capabilities.document && t("pages.settings.channels.capabilities.documents"),
  ].filter((value): value is string => Boolean(value));
  const category = `communication:${channel.id}`;
  const scopedDefinitions = definitions.map((definition) => ({ ...definition, category }));

  return (
    <Card data-testid={`communication-channel-${channel.id}`}>
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base break-words">{channel.title}</CardTitle>
              <Badge variant={channel.state === "ready" ? "default" : "outline"}>
                {t(`pages.settings.channels.states.${channel.state}`)}
              </Badge>
              {channel.origin === "extension" && (
                <Badge variant="secondary">{t("pages.settings.channels.extension")}</Badge>
              )}
            </div>
            {channel.description && <CardDescription>{channel.description}</CardDescription>}
          </div>
          <Button
            variant="outline"
            className="w-full shrink-0 sm:w-auto"
            disabled={testing || channel.state !== "ready" || !channel.capabilities.text}
            onClick={() => onTest(channel)}
            aria-label={t("pages.settings.channels.testAria", { channel: channel.title })}
            data-testid={`communication-channel-${channel.id}-test`}
          >
            {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {testing ? t("pages.settings.channels.testing") : t("pages.settings.channels.test")}
          </Button>
        </div>
        <div
          className="flex flex-wrap gap-2"
          aria-label={t("pages.settings.channels.capabilities.label")}
        >
          {capabilities.map((capability) => (
            <Badge key={capability} variant="outline">
              {capability}
            </Badge>
          ))}
        </div>
        {channel.trustedDelivery && (
          <p
            className="text-xs text-muted-foreground"
            data-testid={`communication-channel-${channel.id}-trust`}
          >
            {channel.trustedDelivery.declared
              ? channel.trustedDelivery.approved
                ? t("pages.settings.channels.trust.approved")
                : t("pages.settings.channels.trust.notApproved")
              : t("pages.settings.channels.trust.ordinaryOnly")}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {scopedDefinitions.length > 0 ? (
          <SettingsEditor
            definitions={scopedDefinitions}
            values={values}
            onSave={onSave}
            testIdPrefix={`user-channel-${channel.id}`}
            enableFullscreenEdit
            collapsible={false}
            categoryLayout="plain"
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t("pages.settings.channels.noSettings")}</p>
        )}
        {channel.helpUrl && (
          <a
            href={channel.helpUrl}
            className="inline-flex text-sm text-primary underline hover:text-primary/80"
          >
            {t("pages.settings.channels.setupGuide", { channel: channel.title })}
          </a>
        )}
      </CardContent>
    </Card>
  );
}
