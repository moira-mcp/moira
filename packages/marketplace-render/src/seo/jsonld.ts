/**
 * JSON-LD structured-data builders for the public catalog. Each returns a `<`-escaped
 * string ready to drop into a `<script type="application/ld+json">` block:
 *
 *   - {@link buildSoftwareApplicationJsonLd} — a flow detail page (extends the interim
 *     `detailJsonLd`: name/description/author/aggregateRating/offers).
 *   - {@link buildItemListJsonLd}            — the gallery (an ordered list of listings).
 *   - {@link buildBreadcrumbJsonLd}          — breadcrumb trail for either page.
 *
 * Escaping is centralized in {@link serializeJsonLd}, so a malicious title/summary
 * containing `</script>` is neutralized (the XSS-safety invariant).
 */

import { serializeJsonLd } from "./escape.js";
import type { DetailView, GalleryView, SeoContext } from "../types.js";

const SCHEMA_CONTEXT = "https://schema.org";

/** `SoftwareApplication` for a flow detail page. */
export function buildSoftwareApplicationJsonLd(detail: DetailView, seo: SeoContext): string {
  const url = `${seo.baseUrl}/w/${detail.reference}`;
  const data: Record<string, unknown> = {
    "@context": SCHEMA_CONTEXT,
    "@type": "SoftwareApplication",
    name: detail.title,
    description: detail.summary ?? `${detail.title} — a Moira workflow`,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any",
    url,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
  if (detail.ownerHandle) {
    data.author = { "@type": "Person", name: detail.ownerHandle };
  }
  if (detail.ratingCount > 0) {
    data.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: detail.ratingAvg.toFixed(1),
      ratingCount: detail.ratingCount,
    };
  }
  return serializeJsonLd(data);
}

/** `ItemList` for the gallery — an ordered list of listing URLs. */
export function buildItemListJsonLd(gallery: GalleryView, seo: SeoContext): string {
  const data: Record<string, unknown> = {
    "@context": SCHEMA_CONTEXT,
    "@type": "ItemList",
    itemListElement: gallery.items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      url: `${seo.baseUrl}/w/${item.reference}`,
      name: item.title,
    })),
  };
  return serializeJsonLd(data);
}

/** A breadcrumb entry (label + absolute URL). */
export interface Breadcrumb {
  name: string;
  url: string;
}

/** `BreadcrumbList` for either page. */
export function buildBreadcrumbJsonLd(trail: Breadcrumb[]): string {
  const data: Record<string, unknown> = {
    "@context": SCHEMA_CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: trail.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: crumb.url,
    })),
  };
  return serializeJsonLd(data);
}
