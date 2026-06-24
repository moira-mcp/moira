/**
 * Marketplace flow detail (in-app, authenticated). Adopt (add as reference) / fork,
 * rate + review, and the "Start in your MCP client" copy affordance (a prompt for the
 * agent — never a raw exec). The crawlable version is the SSR /w/:handle/:slug page.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "../../services/api-client";
import { ROUTES } from "../../constants/routes";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import { RatingStars, VerifiedBadge } from "./components";
import type { MarketplaceListingDetail, MarketplaceReview } from "../../types/api-types";

export function MarketplaceDetail() {
  const { t } = useTranslation();
  const { handle = "", slug = "" } = useParams();
  const [detail, setDetail] = useState<MarketplaceListingDetail | null>(null);
  const [reviews, setReviews] = useState<MarketplaceReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stars, setStars] = useState(5);
  const [reviewText, setReviewText] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, r] = await Promise.all([
        apiClient.getMarketplaceDetail(handle, slug),
        apiClient.getMarketplaceReviews(handle, slug).catch(() => []),
      ]);
      setDetail(d);
      setReviews(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("pages.marketplace.detail.notAvailable"));
    } finally {
      setLoading(false);
    }
  }, [handle, slug, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading)
    return (
      <div className="container mx-auto max-w-3xl px-4 py-6">{t("pages.marketplace.loading")}</div>
    );
  if (error || !detail)
    return (
      <div className="container mx-auto max-w-3xl px-4 py-6">
        <Link to={ROUTES.MARKETPLACE} className="text-primary hover:underline">
          ← {t("pages.marketplace.back")}
        </Link>
        <p className="mt-4 text-muted-foreground">
          {error ?? t("pages.marketplace.detail.notFound")}
        </p>
      </div>
    );

  const l = detail.listing;
  const nodeCount = Array.isArray(detail.workflow.nodes) ? detail.workflow.nodes.length : 0;
  let tags: string[] = [];
  try {
    tags = JSON.parse(l.tags || "[]");
  } catch {
    tags = [];
  }

  const add = async (fork: boolean) => {
    setBusy(true);
    try {
      if (fork) {
        await apiClient.forkListing(l.id);
        toast.success(t("pages.marketplace.detail.forked"));
      } else {
        await apiClient.installListing(l.id);
        toast.success(t("pages.marketplace.detail.added"));
        // Reflect the install immediately (the backend bumped the counter).
        setDetail((prev) =>
          prev
            ? { ...prev, listing: { ...prev.listing, installCount: prev.listing.installCount + 1 } }
            : prev,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("pages.marketplace.detail.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const submitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await apiClient.rateListing(l.id, stars, reviewText.trim() || undefined);
      toast.success(t("pages.marketplace.detail.submitted"));
      setReviewText("");
      setReviews(await apiClient.getMarketplaceReviews(handle, slug).catch(() => reviews));
      setDetail({
        ...detail,
        listing: { ...l, ratingAvg: res.ratingAvg, ratingCount: res.ratingCount },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("pages.marketplace.detail.submitFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container mx-auto max-w-3xl px-4 py-6">
      <Link to={ROUTES.MARKETPLACE} className="text-primary hover:underline text-sm">
        ← {t("pages.marketplace.back")}
      </Link>

      <div className="mt-3 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{l.title}</h1>
          <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
            {l.verified && <VerifiedBadge />}
            <Badge variant="outline">
              {t(`pages.marketplace.category.${l.category}`, { defaultValue: l.category })}
            </Badge>
            <RatingStars avg={l.ratingAvg} count={l.ratingCount} />
            <span>{t("pages.marketplace.installs", { count: l.installCount })}</span>
            <span>{t("pages.marketplace.by", { handle: detail.ownerHandle })}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => add(false)} disabled={busy}>
            {t("pages.marketplace.detail.add")}
          </Button>
          <Button variant="outline" onClick={() => add(true)} disabled={busy}>
            {t("pages.marketplace.detail.fork")}
          </Button>
        </div>
      </div>

      {l.summary && <p className="mt-4">{l.summary}</p>}
      <p className="mt-2 text-sm text-muted-foreground">
        {t("pages.marketplace.steps", { count: nodeCount })}
        {tags.length > 0 && <> · {tags.map((tag) => `#${tag}`).join(" ")}</>}
      </p>

      {/* Run hint — a prompt/command for the agent, never a raw exec from the web. */}
      <Card className="mt-5">
        <CardHeader>
          <CardTitle className="text-base">{t("pages.marketplace.detail.runTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <code className="block rounded bg-muted px-3 py-2 text-sm">
            {`start("${detail.startRef}")`}
          </code>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(`start("${detail.startRef}")`);
              toast.success(t("pages.marketplace.detail.copied"));
            }}
          >
            {t("pages.marketplace.detail.copy")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("pages.marketplace.detail.runHint")}</p>
        </CardContent>
      </Card>

      {/* Paid groundwork — disabled "coming soon" block for paid flows. */}
      {l.isPaid && (
        <Card className="mt-4 opacity-70">
          <CardContent className="pt-5 flex items-center justify-between">
            <span>
              {l.price != null
                ? `${(l.price / 100).toFixed(2)} ${l.currency ?? "USD"}`
                : t("pages.marketplace.detail.paid")}
            </span>
            <Button disabled>{t("pages.marketplace.detail.buySoon")}</Button>
          </CardContent>
        </Card>
      )}

      {/* Reviews */}
      <h2 className="mt-8 text-lg font-semibold">{t("pages.marketplace.detail.reviews")}</h2>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={submitReview}>
        <label className="text-sm">
          {t("pages.marketplace.detail.stars")}
          <select
            className="ml-2 rounded border bg-background px-2 py-1"
            value={stars}
            onChange={(e) => setStars(Number(e.target.value))}
            aria-label={t("pages.marketplace.detail.stars")}
          >
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Input
          className="flex-1 min-w-[200px]"
          placeholder={t("pages.marketplace.detail.reviewPlaceholder")}
          value={reviewText}
          onChange={(e) => setReviewText(e.target.value)}
          aria-label={t("pages.marketplace.detail.reviewAria")}
        />
        <Button type="submit" disabled={busy}>
          {t("pages.marketplace.detail.submit")}
        </Button>
      </form>

      <div className="mt-4 space-y-3">
        {reviews.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("pages.marketplace.detail.noReviews")}</p>
        ) : (
          reviews.map((r) => (
            <div key={r.id} className="border-b pb-2">
              <div className="text-sm">
                <span className="text-amber-500">{"★".repeat(r.stars)}</span>{" "}
                <span className="text-muted-foreground">@{r.authorHandle ?? "user"}</span>
              </div>
              {r.reviewText && <p className="text-sm">{r.reviewText}</p>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
