/**
 * The two per-user auto-pause settings as a switch and a choice of timeout, saved as soon as they
 * change through the ordinary settings API. The note says exactly what counts as activity, because
 * the setting would otherwise promise more than it does: Moira sees only what agents do through it.
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Info, PauseCircle } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HelpPopover } from "@/components/settings/HelpPopover";

export const AUTO_STOP_KEY = "codespaces.auto_stop_enabled";
export const IDLE_TIMEOUT_KEY = "codespaces.idle_timeout_minutes";

/** Choices offered; the 5–240 range is the server's (and GitHub's). */
const TIMEOUT_CHOICES = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240];
const DEFAULT_TIMEOUT = 30;

export function CodespaceAutoPause({
  values,
  onSave,
}: {
  values: Record<string, unknown>;
  onSave: (key: string, value: unknown) => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [saving, setSaving] = useState<string | null>(null);
  const enabled = values[AUTO_STOP_KEY] === undefined ? true : values[AUTO_STOP_KEY] === true;
  const stored = Number(values[IDLE_TIMEOUT_KEY]);
  const timeout = Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_TIMEOUT;
  // A value set elsewhere (the API, the MCP tool) stays selectable even if it is not a preset.
  const choices = TIMEOUT_CHOICES.includes(timeout)
    ? TIMEOUT_CHOICES
    : [...TIMEOUT_CHOICES, timeout].sort((left, right) => left - right);

  const save = async (key: string, value: unknown) => {
    try {
      setSaving(key);
      await onSave(key, value);
      toast.success(t("pages.settings.codespaces.autoPause.saved"));
    } catch {
      // The settings API answers in English; the reader is told in their own language.
      toast.error(t("pages.settings.codespaces.autoPause.saveFailed"));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card data-testid="codespace-auto-pause">
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <PauseCircle className="size-4 text-muted-foreground" aria-hidden="true" />
          <CardTitle className="text-base">
            {t("pages.settings.codespaces.autoPause.title")}
          </CardTitle>
          <HelpPopover
            title={t("pages.settings.codespaces.autoPause.helpTitle")}
            data-testid="codespace-auto-pause-help"
          >
            <p>{t("pages.settings.codespaces.autoPause.helpCounts")}</p>
            <p>{t("pages.settings.codespaces.autoPause.helpResume")}</p>
          </HelpPopover>
        </div>
        <CardDescription>{t("pages.settings.codespaces.autoPause.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="codespace-auto-pause-switch" className="text-sm font-medium">
              {t("pages.settings.codespaces.autoPause.enable")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t("pages.settings.codespaces.autoPause.enableDescription")}
            </p>
          </div>
          <Switch
            id="codespace-auto-pause-switch"
            checked={enabled}
            disabled={saving !== null}
            onCheckedChange={(checked) => void save(AUTO_STOP_KEY, checked)}
            data-testid="codespace-auto-pause-switch"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label htmlFor="codespace-auto-pause-timeout" className="text-sm font-medium">
              {t("pages.settings.codespaces.autoPause.timeout")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t("pages.settings.codespaces.autoPause.timeoutDescription")}
            </p>
          </div>
          <Select
            value={String(timeout)}
            disabled={!enabled || saving !== null}
            onValueChange={(value) => void save(IDLE_TIMEOUT_KEY, Number(value))}
          >
            <SelectTrigger
              id="codespace-auto-pause-timeout"
              className="w-44"
              data-testid="codespace-auto-pause-timeout"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {t("pages.settings.codespaces.autoPause.minutes", { count: minutes })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div
          className="flex gap-2 rounded-lg border bg-muted/40 p-3 text-sm leading-6 text-muted-foreground"
          data-testid="codespace-auto-pause-note"
        >
          <Info className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <p>{t("pages.settings.codespaces.autoPause.note")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
