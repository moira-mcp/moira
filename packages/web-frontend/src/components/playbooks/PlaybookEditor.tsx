/* eslint-disable no-console */
/**
 * Write or change one playbook.
 *
 * The reason this is not a plain text box: a playbook's content resolves at every step, so saving
 * an edit changes the behaviour of runs that are already under way. The editor asks the server how
 * many such runs there are and says so before the change is written, not after — afterwards the
 * information is useless.
 *
 * Note: console.error is used for browser debugging of API errors, as elsewhere in this app.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Save, X } from "lucide-react";
import { apiClient, type PlaybookUsage } from "../../services/api-client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Label } from "../ui/label";
import { VisibilityToggle, type ResourceVisibility } from "../access/VisibilityToggle";

interface PlaybookEditorProps {
  /** Null while creating: the name is still being chosen. */
  slug: string | null;
  onClose: (saved: boolean) => void;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;

export const PlaybookEditor: React.FC<PlaybookEditorProps> = ({ slug, onClose }) => {
  const { t } = useTranslation();

  const [name, setName] = useState(slug ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [visibility, setVisibility] = useState<ResourceVisibility>("private");
  const [loading, setLoading] = useState(Boolean(slug));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<PlaybookUsage | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const playbook = await apiClient.getPlaybook(slug);
        if (cancelled) return;
        setTitle(playbook.name ?? "");
        setDescription(playbook.description ?? "");
        setContent(playbook.content);
        setVisibility(playbook.visibility);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("common.errors.failedToLoad"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, t]);

  // The warning is only truthful while the playbook exists: a playbook being created cannot have
  // runs standing on it yet.
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    apiClient
      .getPlaybookUsage(slug)
      .then((result) => {
        if (!cancelled) setUsage(result);
      })
      .catch(() => {
        // The warning is advisory; failing to fetch it must not block editing.
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const handleSave = useCallback(async () => {
    const targetName = (slug ?? name).trim();
    if (!SLUG_PATTERN.test(targetName)) {
      setError(t("pages.playbooks.editor.invalidName"));
      return;
    }
    try {
      setSaving(true);
      setError(null);
      await apiClient.savePlaybook(targetName, {
        content,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
      });
      onClose(true);
    } catch (err) {
      console.error("Failed to save playbook:", err);
      setError(err instanceof Error ? err.message : t("common.errors.failedToUpdate"));
    } finally {
      setSaving(false);
    }
  }, [slug, name, content, title, description, onClose, t]);

  const handleVisibility = useCallback(
    async (next: ResourceVisibility) => {
      if (!slug) return;
      const previous = visibility;
      setVisibility(next);
      try {
        await apiClient.setPlaybookVisibility(slug, next);
      } catch (err) {
        console.error("Failed to change playbook visibility:", err);
        setVisibility(previous);
      }
    },
    [slug, visibility],
  );

  if (loading) {
    return (
      <div className="border rounded-lg p-4 text-muted-foreground" data-testid="playbook-editor">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="border rounded-lg p-4 space-y-3" data-testid="playbook-editor">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[12rem]">
          <Label htmlFor="playbook-name">{t("pages.playbooks.editor.name")}</Label>
          <Input
            id="playbook-name"
            value={slug ?? name}
            onChange={(e) => setName(e.target.value)}
            disabled={Boolean(slug)}
            placeholder="review-standard"
            data-testid="playbook-name-input"
          />
        </div>
        <div className="flex-1 min-w-[12rem]">
          <Label htmlFor="playbook-title">{t("pages.playbooks.editor.title")}</Label>
          <Input
            id="playbook-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="playbook-title-input"
          />
        </div>
        {slug && (
          <VisibilityToggle
            visibility={visibility}
            onChange={handleVisibility}
            testId="playbook-visibility-toggle"
          />
        )}
      </div>

      <div>
        <Label htmlFor="playbook-description">{t("pages.playbooks.editor.description")}</Label>
        <Input
          id="playbook-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="playbook-description-input"
        />
      </div>

      <div>
        <Label htmlFor="playbook-content">{t("pages.playbooks.editor.content")}</Label>
        <Textarea
          id="playbook-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={12}
          className="font-mono text-sm"
          data-testid="playbook-content-input"
        />
      </div>

      <div className="text-xs text-muted-foreground" data-testid="playbook-reference-hint">
        {t("pages.playbooks.editor.referenceHint", { reference: `{{playbook:${slug ?? name}}}` })}
      </div>

      {usage && usage.executions > 0 && (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          data-testid="playbook-live-runs-warning"
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
          <div>
            <div className="font-medium">
              {t("pages.playbooks.editor.liveRunsTitle", { count: usage.executions })}
            </div>
            <div className="text-muted-foreground">
              {usage.complete
                ? t("pages.playbooks.editor.liveRunsHint")
                : t("pages.playbooks.editor.liveRunsPartialHint")}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="text-sm text-destructive" data-testid="playbook-editor-error">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving} data-testid="save-playbook-button">
          <Save className="h-4 w-4 mr-2" />
          {saving ? t("common.loading") : t("common.save")}
        </Button>
        <Button variant="ghost" onClick={() => onClose(false)} disabled={saving}>
          <X className="h-4 w-4 mr-2" />
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
};
