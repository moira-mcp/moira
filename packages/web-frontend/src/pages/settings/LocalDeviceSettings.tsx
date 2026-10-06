import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Laptop, RefreshCw } from "lucide-react";
import type {
  LocalDeviceSettingsValue,
  LocalDeviceView,
  LocalPairingView,
} from "@mcp-moira/shared";
import { apiClient } from "@/services/api-client";
import { useResource } from "@/hooks/useResource";
import { useRefreshOnActivation } from "@/components/settings/useRefreshOnActivation";
import { useReadOwnerGuard } from "@/auth/ReadScopeBoundary";
import { DataRegion } from "@/components/DataRegion";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineError } from "@/components/inline-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { SettingsSubsection } from "@/components/settings/SettingsSection";
import { useGitHubCodespaces } from "./GitHubCodespacesData";
import { LocalDeviceEditor } from "./LocalDeviceEditor";

function DevicePermissions({ device }: { device: LocalDeviceView }) {
  const { t, i18n } = useTranslation();
  const policy = device.policy;
  return (
    <div className="space-y-2 text-sm [overflow-wrap:anywhere]">
      <p>
        {t("localDevices.limits", {
          cpu: policy.machine.cpuCores,
          memory: policy.machine.memoryBytes / 1024 ** 3,
          storage: policy.machine.storageBytes / 1024 ** 3,
          count: policy.maxSandboxes,
        })}
      </p>
      <p>
        {t("localDevices.lease", {
          expires: new Date(policy.leaseUntil).toLocaleString(i18n.language),
        })}
      </p>
      {!policy.enabled && <p>{t("localDevices.disabled")}</p>}
      <h4 className="font-medium">{t("localDevices.repositories")}</h4>
      {policy.repositories.length === 0 ? (
        <p>{t("localDevices.noRepositories")}</p>
      ) : (
        <ul className="space-y-2">
          {policy.repositories.map((repository) => (
            <li key={repository.id}>
              <p className="font-medium">{repository.fullName}</p>
              <p className="text-muted-foreground">
                {t("localDevices.permissions", {
                  push: t(repository.allowPush ? "localDevices.yes" : "localDevices.no"),
                  delete: t(repository.allowDelete ? "localDevices.yes" : "localDevices.no"),
                })}
              </p>
              <p className="text-muted-foreground">
                {t("localDevices.domains", {
                  domains: repository.domains.join(", ") || t("localDevices.noDomains"),
                })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Pairing secrets remain page-local; the server sends only public device grants on later reads. */
export function LocalDeviceSettings({ active = true }: { active?: boolean }) {
  const { t, i18n } = useTranslation();
  const guard = useReadOwnerGuard();
  const { reloadManagement } = useGitHubCodespaces();
  const resource = useResource(
    "local-device-settings",
    () => apiClient.getLocalDevices(),
    () => t("localDevices.loadFailed"),
  );
  useRefreshOnActivation(active, resource.refresh);
  const [pairing, setPairing] = useState<Awaited<
    ReturnType<typeof apiClient.beginLocalEnrollment>
  > | null>(null);
  const [beginning, setBeginning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<{
    device: LocalDeviceView;
    pairing?: LocalPairingView;
  } | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const date = (timestamp: number) => new Date(timestamp).toLocaleString(i18n.language);
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const server = new URL(apiClient.getConfig().baseURL || "/", window.location.origin).href.replace(
    /\/$/,
    "",
  );
  const command = pairing
    ? `npm run local -- enroll --server ${shellQuote(server)} --pairing-id ${shellQuote(pairing.pairingId)}`
    : "";

  const begin = async () => {
    const owned = guard();
    setBeginning(true);
    setError(null);
    try {
      const next = await apiClient.beginLocalEnrollment();
      if (!owned()) return;
      setPairing(next);
      await resource.refresh();
    } catch {
      if (owned()) setError(t("localDevices.actionFailed"));
    } finally {
      if (owned()) setBeginning(false);
    }
  };
  const copy = async (value: string) => {
    const owned = guard();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      if (owned()) setError(t("localDevices.copyFailed"));
    }
  };
  const confirm = async () => {
    if (!decision) return;
    const owned = guard();
    const current = decision;
    setDecisionError(null);
    try {
      const next = current.pairing
        ? await apiClient.confirmLocalEnrollment(current.pairing.id, current.pairing.revision)
        : await apiClient.revokeLocalDevice(
            current.device.deviceId,
            current.device.deviceGeneration,
          );
      if (!owned()) throw new Error("Retired local device operation");
      resource.update((value) => ({
        ...value,
        devices: value.devices.map((device) => (device.deviceId === next.deviceId ? next : device)),
      }));
      if (current.pairing?.id === pairing?.pairingId) setPairing(null);
      await resource.refresh();
      if (owned()) await reloadManagement({ silent: true });
    } catch (caught) {
      if (owned()) setDecisionError(t("localDevices.actionFailed"));
      throw caught;
    }
  };
  const saveSettings = async (
    device: LocalDeviceView,
    settings: LocalDeviceSettingsValue,
    expectedRevision: number,
  ) => {
    const owned = guard(false);
    const next = await apiClient.updateLocalDeviceSettings(
      device.deviceId,
      device.deviceGeneration,
      expectedRevision,
      settings,
    );
    if (!owned()) throw new Error("Retired local device operation");
    resource.update((value) => ({
      ...value,
      devices: value.devices.map((current) =>
        current.deviceId === next.deviceId ? next : current,
      ),
    }));
    await resource.refresh();
  };

  return (
    <SettingsSubsection
      title={t("localDevices.title")}
      description={t("localDevices.description")}
      data-testid="local-device-settings"
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void resource.refresh()}
            aria-label={t("localDevices.refresh")}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
          </Button>
          <Button size="sm" onClick={() => void begin()} disabled={beginning}>
            {t("localDevices.begin")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <InlineError title={t("common.errors.failedToLoad")} message={error} />}
        {pairing && (
          <div className="space-y-3 rounded-lg border p-3" data-testid="local-device-pairing">
            <h3 className="font-medium">{t("localDevices.enrollmentTitle")}</h3>
            <Label htmlFor="local-device-command">{t("localDevices.command")}</Label>
            <Input
              id="local-device-command"
              readOnly
              value={command}
              className="font-mono text-xs"
            />
            <Button variant="outline" size="sm" onClick={() => void copy(command)}>
              {t("localDevices.copyCommand")}
            </Button>
            <Label htmlFor="local-device-pairing-token">{t("localDevices.token")}</Label>
            <Input
              id="local-device-pairing-token"
              readOnly
              value={pairing.pairingToken}
              autoComplete="off"
            />
            <Button variant="outline" size="sm" onClick={() => void copy(pairing.pairingToken)}>
              {t("localDevices.copyToken")}
            </Button>
            <p className="text-sm text-muted-foreground">
              {t("localDevices.tokenHint", { expires: date(pairing.expiresAt) })}
            </p>
            <p className="text-sm">{t("localDevices.confirmHint")}</p>
            {pairing.expiresAt <= Date.now() && <p role="status">{t("localDevices.expired")}</p>}
          </div>
        )}
        <DataRegion
          hasResult={resource.data !== undefined}
          pending={resource.pending}
          error={resource.error}
          onRetry={resource.refresh}
          testId="local-device-region"
        >
          {resource.data?.devices.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("localDevices.empty")}</p>
          )}
          <ul className="space-y-3">
            {resource.data?.devices.map((device) => {
              const pendingPair = resource.data?.pairings.find(
                (pair) =>
                  pair.deviceId === device.deviceId && pair.state === "waiting_confirmation",
              );
              return (
                <li
                  key={device.deviceId}
                  className="space-y-3 rounded-lg border p-3"
                  data-testid={`local-device-${device.deviceId}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="flex min-w-0 items-center gap-2 font-medium [overflow-wrap:anywhere]">
                      <Laptop className="size-4 shrink-0" aria-hidden="true" />
                      {device.label}
                    </h3>
                    <Badge variant="outline">{t(`localDevices.status.${device.status}`)}</Badge>
                  </div>
                  <p className="text-sm font-medium">{t("localDevices.editor.appliedGrants")}</p>
                  <DevicePermissions device={device} />
                  {device.status === "active" && (
                    <LocalDeviceEditor
                      device={device}
                      onSave={(settings, expectedRevision) =>
                        saveSettings(device, settings, expectedRevision)
                      }
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t("localDevices.lastSeen", {
                      date:
                        device.lastSeenAt === null
                          ? t("localDevices.unknown")
                          : date(device.lastSeenAt),
                    })}
                  </p>
                  {device.status !== "revoked" && (
                    <Button
                      variant={pendingPair ? "default" : "destructive"}
                      size="sm"
                      onClick={() => {
                        setDecisionError(null);
                        setDecision({ device, pairing: pendingPair });
                      }}
                    >
                      {t(pendingPair ? "localDevices.confirm" : "localDevices.revoke")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {resource.data?.pairings
            .filter((pair) => pair.state === "waiting_local")
            .map((pair) => (
              <p key={pair.id} className="text-sm text-muted-foreground">
                {t("localDevices.waiting")} · {date(pair.expiresAt)}
              </p>
            ))}
        </DataRegion>
      </div>
      <ConfirmDialog
        open={decision !== null}
        onOpenChange={(open) => {
          if (!open) setDecision(null);
        }}
        confirmationKey={decision}
        title={t(decision?.pairing ? "localDevices.confirmTitle" : "localDevices.revokeTitle")}
        description={t(
          decision?.pairing ? "localDevices.confirmDescription" : "localDevices.revokeDescription",
          { label: decision?.device.label ?? "" },
        )}
        confirmLabel={t(decision?.pairing ? "localDevices.confirm" : "localDevices.revoke")}
        variant={decision?.pairing ? "default" : "destructive"}
        onConfirm={confirm}
      >
        {decision && <DevicePermissions device={decision.device} />}
        {decisionError && (
          <InlineError title={t("common.errors.failedToLoad")} message={decisionError} />
        )}
      </ConfirmDialog>
    </SettingsSubsection>
  );
}
