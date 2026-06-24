/**
 * Publish a workflow to the marketplace (authenticated SPA route). Pick one of your
 * own workflows, set category/tags/summary, and publish. The paid pricing section is
 * rendered DISABLED with a "coming soon" note while the `paidWorkflows` feature is off.
 */

import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "../../services/api-client";
import { ROUTES } from "../../constants/routes";
import { useFeatures } from "../../hooks/useFeatures";
import { useWorkflowList } from "../../hooks/useWorkflowData";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

export function PublishListing() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isEnabled } = useFeatures();
  const paidEnabled = isEnabled("paidWorkflows");
  const { loadWorkflows, workflows } = useWorkflowList();

  const [categories, setCategories] = useState<Array<{ id: string; label: string }>>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [summary, setSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void loadWorkflows();
    apiClient
      .getMarketplaceCategories()
      .then((c) => {
        setCategories(c);
        if (c[0]) setCategory(c[0].id);
      })
      .catch(() => setCategories([]));
  }, [loadWorkflows]);

  // Only the user's OWN workflows can be published. The list endpoint always
  // populates accessType (owner|shared|public), so fail closed on "owner".
  const ownWorkflows = (workflows?.workflows ?? []).filter((w) => w.accessType === "owner");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workflowId) {
      toast.error(t("pages.marketplace.publishForm.pickFirst"));
      return;
    }
    setSubmitting(true);
    try {
      const detail = await apiClient.publishListing({
        workflowId,
        category: category || undefined,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        summary: summary.trim() || undefined,
      });
      toast.success(t("pages.marketplace.publishForm.published"));
      // startRef is "handle/slug" — derive the in-app detail route from it.
      const slugPart = detail.startRef.split("/").slice(1).join("/");
      navigate(`${ROUTES.MARKETPLACE}/flow/${detail.ownerHandle}/${slugPart}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("pages.marketplace.publishForm.failed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="container mx-auto max-w-2xl px-4 py-6">
      <Link to={ROUTES.MARKETPLACE} className="text-primary hover:underline text-sm">
        ← {t("pages.marketplace.back")}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">{t("pages.marketplace.publishForm.title")}</h1>
      <p className="text-sm text-muted-foreground">
        {t("pages.marketplace.publishForm.subtitle")}
      </p>

      <form className="mt-5 space-y-4" onSubmit={submit}>
        <div>
          <label className="text-sm font-medium">
            {t("pages.marketplace.publishForm.workflow")}
          </label>
          <Select value={workflowId} onValueChange={setWorkflowId}>
            <SelectTrigger aria-label={t("pages.marketplace.publishForm.workflow")}>
              <SelectValue placeholder={t("pages.marketplace.publishForm.selectWorkflow")} />
            </SelectTrigger>
            <SelectContent>
              {ownWorkflows.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.metadata.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-sm font-medium">
            {t("pages.marketplace.publishForm.category")}
          </label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger aria-label={t("pages.marketplace.publishForm.category")}>
              <SelectValue placeholder={t("pages.marketplace.publishForm.category")} />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-sm font-medium">{t("pages.marketplace.publishForm.tags")}</label>
          <Input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t("pages.marketplace.publishForm.tagsPlaceholder")}
          />
        </div>

        <div>
          <label className="text-sm font-medium">
            {t("pages.marketplace.publishForm.summary")}
          </label>
          <Input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder={t("pages.marketplace.publishForm.summaryPlaceholder")}
          />
        </div>

        {/* Paid groundwork — disabled "coming soon" pricing section. */}
        <Card className="opacity-60">
          <CardHeader>
            <CardTitle className="text-base">
              {t("pages.marketplace.publishForm.pricing")}{" "}
              <span className="text-xs text-muted-foreground">
                — {t("pages.marketplace.publishForm.comingSoon")}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled
                checked={false}
                aria-label={t("pages.marketplace.publishForm.makePaid")}
              />{" "}
              {t("pages.marketplace.publishForm.makePaid")}
            </label>
            <Input type="number" placeholder={t("pages.marketplace.publishForm.price")} disabled />
            <p className="text-xs text-muted-foreground">
              {paidEnabled
                ? t("pages.marketplace.publishForm.sellingUnavailable")
                : t("pages.marketplace.publishForm.sellingUnavailableInstance")}
            </p>
          </CardContent>
        </Card>

        <Button type="submit" disabled={submitting || !workflowId}>
          {submitting
            ? t("pages.marketplace.publishForm.publishing")
            : t("pages.marketplace.publishForm.publish")}
        </Button>
      </form>
    </div>
  );
}
