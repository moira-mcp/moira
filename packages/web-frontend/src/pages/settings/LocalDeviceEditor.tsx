import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  assertLocalControlSettings,
  MAX_LOCAL_WORK_LEASE_MS,
  localDeviceSettingsSchema,
  type LocalDeviceSettingsValue,
} from "@mcp-moira/shared/local-management-types";
import type { LocalDeviceView } from "@mcp-moira/shared";
import { useReadOwnerGuard } from "@/auth/ReadScopeBoundary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { InlineError } from "@/components/inline-error";

type NumericKey =
  | "cpuCores"
  | "memoryBytes"
  | "storageBytes"
  | "dockerBytes"
  | "maxSandboxes"
  | "maxOperationMs"
  | "maxOutputBytes"
  | "maxConcurrent"
  | "maxNetworkBytes"
  | "maxNetworkConnections";
const GIB = 1024 ** 3;
const numericFields: Array<{ key: NumericKey; scale: number; advanced?: boolean }> = [
  { key: "cpuCores", scale: 1 },
  { key: "memoryBytes", scale: GIB },
  { key: "storageBytes", scale: GIB },
  { key: "dockerBytes", scale: GIB },
  { key: "maxSandboxes", scale: 1 },
  { key: "maxOperationMs", scale: 1000, advanced: true },
  { key: "maxOutputBytes", scale: 1024 ** 2, advanced: true },
  { key: "maxConcurrent", scale: 1, advanced: true },
  { key: "maxNetworkBytes", scale: 1024 ** 2, advanced: true },
  { key: "maxNetworkConnections", scale: 1, advanced: true },
];

/** Requested settings and local applied policy are deliberately separate. Drafts belong to fields. */
export function LocalDeviceEditor({
  device,
  onSave,
}: {
  device: LocalDeviceView;
  onSave: (settings: LocalDeviceSettingsValue, expectedRevision: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const guard = useReadOwnerGuard();
  const control = device.control;
  const [draft, setDraft] = useState<LocalDeviceSettingsValue | null>(control?.settings ?? null);
  const dirty = useRef(new Set<keyof LocalDeviceSettingsValue>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [domainText, setDomainText] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!control) return;
    setDraft((previous) =>
      previous
        ? (Object.fromEntries(
            Object.entries(control.settings).map(([key, value]) => [
              key,
              dirty.current.has(key as keyof LocalDeviceSettingsValue)
                ? previous[key as keyof LocalDeviceSettingsValue]
                : value,
            ]),
          ) as LocalDeviceSettingsValue)
        : control.settings,
    );
  }, [control]);
  const change = <K extends keyof LocalDeviceSettingsValue>(
    key: K,
    value: LocalDeviceSettingsValue[K],
  ) => {
    dirty.current.add(key);
    setDraft((previous) => (previous ? { ...previous, [key]: value } : previous));
    setError(null);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || !control?.optedIn || pending) return;
    const parsed = localDeviceSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setError(t("localDevices.editor.invalid"));
      return;
    }
    try {
      if (!control.ceiling) throw new Error("Unknown local ceiling");
      assertLocalControlSettings(parsed.data, control.ceiling, Date.now());
    } catch {
      setError(t("localDevices.editor.invalid"));
      return;
    }
    const owned = guard(false);
    const snapshot = draft;
    const submitted = parsed.data;
    setPending(true);
    setError(null);
    try {
      await onSave(submitted, control.revision);
      if (!owned()) return;
      setDraft((current) => {
        if (!current) return current;
        return Object.fromEntries(
          Object.entries(current).map(([field, value]) => {
            const key = field as keyof LocalDeviceSettingsValue;
            if (JSON.stringify(value) === JSON.stringify(snapshot[key])) {
              dirty.current.delete(key);
              return [key, submitted[key]];
            }
            return [key, value];
          }),
        ) as LocalDeviceSettingsValue;
      });
    } catch {
      if (owned()) setError(t("localDevices.actionFailed"));
    } finally {
      if (owned()) setPending(false);
    }
  };
  const prefix = `local-control-${device.deviceId}`;
  if (!control?.optedIn || !control.ceiling || !draft)
    return <p className="text-sm text-muted-foreground">{t("localDevices.editor.optIn")}</p>;
  const ceiling = control.ceiling;
  const numeric = (advanced: boolean) =>
    numericFields
      .filter((field) => Boolean(field.advanced) === advanced)
      .map(({ key, scale }) => (
        <div key={key} className="space-y-1.5">
          <Label htmlFor={`${prefix}-${key}`}>{t(`localDevices.editor.${key}`)}</Label>
          <Input
            id={`${prefix}-${key}`}
            type="number"
            min={0}
            max={ceiling[key] / scale}
            step={1}
            value={draft[key] / scale}
            onChange={(event) => change(key, Number(event.currentTarget.value) * scale)}
          />
          <p className="text-xs text-muted-foreground">
            {t("localDevices.editor.ceiling", { value: ceiling[key] / scale })}
          </p>
        </div>
      ));
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-5 border-t pt-4"
      aria-label={t("localDevices.editor.title", { label: device.label })}
    >
      <div className="space-y-1">
        <h4 className="font-medium">{t("localDevices.editor.title", { label: device.label })}</h4>
        <p role="status" className="text-sm">
          {t(`localDevices.editor.states.${control.status}`, {
            requested: control.revision,
            applied: control.appliedRevision,
          })}
        </p>
        <p className="text-sm text-muted-foreground">{t("localDevices.editor.requestHint")}</p>
        <p className="text-sm text-muted-foreground">{t("localDevices.editor.futureProfile")}</p>
        {control.error && (
          <InlineError title={t("localDevices.editor.rejected")} message={control.error.message} />
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-label`}>{t("localDevices.editor.label")}</Label>
          <Input
            id={`${prefix}-label`}
            value={draft.label}
            onChange={(event) => change("label", event.currentTarget.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${prefix}-enabled`}
            checked={draft.enabled}
            onCheckedChange={(value) => change("enabled", value === true)}
          />
          <Label htmlFor={`${prefix}-enabled`}>{t("localDevices.editor.enabled")}</Label>
        </div>
        {numeric(false)}
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-lease`}>{t("localDevices.editor.lease")}</Label>
          <Input
            id={`${prefix}-lease`}
            type="datetime-local"
            value={
              Number.isFinite(draft.leaseUntil)
                ? new Date(
                    draft.leaseUntil - new Date(draft.leaseUntil).getTimezoneOffset() * 60_000,
                  )
                    .toISOString()
                    .slice(0, 16)
                : ""
            }
            onChange={(event) =>
              change("leaseUntil", new Date(event.currentTarget.value).getTime())
            }
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={control.ceiling.maxLeaseMs < MAX_LOCAL_WORK_LEASE_MS}
            onClick={() => change("leaseUntil", Date.now() + MAX_LOCAL_WORK_LEASE_MS)}
          >
            {t("localDevices.editor.week")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t("localDevices.editor.leaseCeiling", {
              hours: control.ceiling.maxLeaseMs / 3600_000,
            })}
          </p>
        </div>
      </div>
      <fieldset className="space-y-3">
        <legend className="font-medium">{t("localDevices.repositories")}</legend>
        {draft.repositories.map((repository, index) => {
          const update = (next: typeof repository) =>
            change(
              "repositories",
              draft.repositories.map((current, at) => (at === index ? next : current)),
            );
          return (
            <div key={repository.id} className="space-y-3 rounded-md border p-3">
              <Label htmlFor={`${prefix}-repo-${repository.id}`}>
                {t("localDevices.editor.repository")}
              </Label>
              <Input
                id={`${prefix}-repo-${repository.id}`}
                value={repository.fullName}
                placeholder={t("localDevices.editor.repositoryPlaceholder")}
                onChange={(event) => update({ ...repository, fullName: event.currentTarget.value })}
              />
              <div className="flex flex-wrap gap-x-5 gap-y-3">
                {(["private", "allowPush", "allowPullRequests", "allowDelete"] as const).map(
                  (key) => (
                    <div key={key} className="flex items-center gap-2">
                      <Checkbox
                        id={`${prefix}-${repository.id}-${key}`}
                        checked={repository[key] === true}
                        onCheckedChange={(value) =>
                          update({ ...repository, [key]: value === true })
                        }
                      />
                      <Label htmlFor={`${prefix}-${repository.id}-${key}`}>
                        {t(`localDevices.editor.${key}`)}
                      </Label>
                    </div>
                  ),
                )}
              </div>
              <Label htmlFor={`${prefix}-domains-${repository.id}`}>
                {t("localDevices.editor.domains")}
              </Label>
              <Input
                id={`${prefix}-domains-${repository.id}`}
                value={
                  dirty.current.has("repositories")
                    ? (domainText[repository.id] ?? repository.domains.join(", "))
                    : repository.domains.join(", ")
                }
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDomainText((previous) => ({ ...previous, [repository.id]: value }));
                  update({
                    ...repository,
                    domains: value
                      .split(",")
                      .map((domain) => domain.trim())
                      .filter(Boolean),
                  });
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  change(
                    "repositories",
                    draft.repositories.filter((_, at) => at !== index),
                  )
                }
              >
                {t("localDevices.editor.removeRepository")}
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            change("repositories", [
              ...draft.repositories,
              {
                id: crypto.randomUUID(),
                fullName: "",
                private: false,
                allowPush: false,
                allowDelete: false,
                allowPullRequests: false,
                domains: ["github.com"],
              },
            ])
          }
        >
          {t("localDevices.editor.addRepository")}
        </Button>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-medium">{t("localDevices.editor.gitAuthor")}</legend>
        <p className="text-sm text-muted-foreground sm:col-span-2">
          {t("localDevices.editor.authorHint")}
        </p>
        {(["name", "email"] as const).map((key) => (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={`${prefix}-author-${key}`}>
              {t(`localDevices.editor.author${key === "name" ? "Name" : "Email"}`)}
            </Label>
            <Input
              id={`${prefix}-author-${key}`}
              value={draft.gitAuthor?.[key] ?? ""}
              onChange={(event) => {
                const next = {
                  name: draft.gitAuthor?.name ?? "",
                  email: draft.gitAuthor?.email ?? "",
                  [key]: event.currentTarget.value,
                };
                change("gitAuthor", !next.name && !next.email ? null : next);
              }}
            />
          </div>
        ))}
      </fieldset>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="outline">
            {t("localDevices.editor.advanced")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-4 grid gap-4 sm:grid-cols-2">
          {numeric(true)}
        </CollapsibleContent>
      </Collapsible>
      {error && <InlineError title={t("common.errors.failedToLoad")} message={error} />}
      <Button type="submit" disabled={pending || dirty.current.size === 0}>
        {t(pending ? "localDevices.editor.saving" : "localDevices.editor.save")}
      </Button>
    </form>
  );
}
