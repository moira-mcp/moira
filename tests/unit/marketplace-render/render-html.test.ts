/**
 * Unit tests for @mcp-moira/marketplace-render render functions + SEO builders.
 *
 * Covers: crawlable semantic HTML, complete & escaped SEO `<head>`, well-formed JSON-LD
 * (SoftwareApplication for detail, ItemList for gallery), localized counts (EN + RU via
 * the shared i18n utility), localized enum labels (category/status not raw), and the
 * JSON-LD XSS-safety invariant (a malicious title/summary cannot break out of the
 * `<script type="application/ld+json">` block).
 *
 * Pure render layer → node environment (renderToString), no DB.
 */

import { describe, it, expect } from "@jest/globals";
import {
  renderExploreToHtml,
  renderDetailToHtml,
  type GalleryView,
  type DetailView,
  type SeoContext,
  type ViewerContext,
} from "@mcp-moira/marketplace-render";

const BASE_URL = "https://moira.example.com";

function seo(locale: "en" | "ru"): SeoContext {
  return { baseUrl: BASE_URL, locale };
}

function galleryCard(overrides: Partial<GalleryView["items"][number]> = {}) {
  return {
    reference: "alice/research-flow",
    title: "Research Flow",
    summary: "A verified-research workflow.",
    category: "research",
    ownerHandle: "alice",
    verified: true,
    installCount: 0,
    ratingAvg: 0,
    ratingCount: 0,
    inLibrary: false,
    isOwn: false,
    ...overrides,
  };
}

function detailView(overrides: Partial<DetailView> = {}): DetailView {
  return {
    reference: "alice/research-flow",
    title: "Research Flow",
    summary: "A verified-research workflow.",
    category: "research",
    ownerHandle: "alice",
    verified: true,
    installCount: 2,
    ratingAvg: 4.5,
    ratingCount: 6,
    tags: ["research", "verified"],
    stepCount: 2,
    inLibrary: false,
    isOwn: false,
    ...overrides,
  };
}

const ANON: ViewerContext | null = null;

/** Extract the JSON object from the Nth `<script type="application/ld+json">` block. */
function jsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

describe("renderExploreToHtml", () => {
  it("emits crawlable semantic gallery HTML with real detail links", () => {
    const gallery: GalleryView = { items: [galleryCard()], total: 1 };
    const { html } = renderExploreToHtml(gallery, ANON, seo("en"));

    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('data-mp="explore"'); // <main>
    expect(html).toContain("<main");
    expect(html).toContain("<ul");
    // A crawlable, JS-free <a href> to the detail page.
    expect(html).toContain(`href="${BASE_URL}/w/alice/research-flow"`);
    expect(html).toContain("Research Flow");
  });

  it("emits complete, escaped SEO head (title/description/canonical/OG/Twitter)", () => {
    const gallery: GalleryView = { items: [galleryCard()], total: 1 };
    const { html } = renderExploreToHtml(gallery, ANON, seo("en"));

    expect(html).toContain("<title>Explore workflows — Moira Marketplace</title>");
    expect(html).toContain('<meta name="description"');
    expect(html).toContain(`<link rel="canonical" href="${BASE_URL}/explore" />`);
    expect(html).toContain('<meta property="og:type" content="website" />');
    expect(html).toContain(`<meta property="og:url" content="${BASE_URL}/explore" />`);
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
  });

  it("emits a well-formed ItemList JSON-LD for the gallery", () => {
    const gallery: GalleryView = {
      items: [galleryCard(), galleryCard({ reference: "bob/data-flow", title: "Data Flow" })],
      total: 2,
    };
    const { html } = renderExploreToHtml(gallery, ANON, seo("en"));
    const blocks = jsonLdBlocks(html);
    const itemList = blocks.map((b) => JSON.parse(b)).find((d) => d["@type"] === "ItemList");

    expect(itemList).toBeDefined();
    expect(itemList["@context"]).toBe("https://schema.org");
    expect(itemList.itemListElement).toHaveLength(2);
    expect(itemList.itemListElement[0]).toMatchObject({
      "@type": "ListItem",
      position: 1,
      url: `${BASE_URL}/w/alice/research-flow`,
      name: "Research Flow",
    });
    // Breadcrumb present alongside.
    expect(blocks.map((b) => JSON.parse(b)).some((d) => d["@type"] === "BreadcrumbList")).toBe(
      true,
    );
  });

  it("localizes the gallery total count (EN vs RU CLDR forms)", () => {
    const galleryTwo: GalleryView = { items: [galleryCard()], total: 2 };
    const galleryFive: GalleryView = { items: [galleryCard()], total: 5 };

    const en = renderExploreToHtml(galleryTwo, ANON, seo("en")).html;
    expect(en).toContain("2 published");

    const ruFew = renderExploreToHtml(galleryTwo, ANON, seo("ru")).html;
    expect(ruFew).toContain("2 опубликовано");
    const ruMany = renderExploreToHtml(galleryFive, ANON, seo("ru")).html;
    expect(ruMany).toContain("5 опубликовано");
  });

  it("localizes the category enum (not the raw value) in RU", () => {
    const gallery: GalleryView = { items: [galleryCard({ category: "research" })], total: 1 };
    const ru = renderExploreToHtml(gallery, ANON, seo("ru")).html;
    expect(ru).toContain("Исследования");
    expect(ru).not.toMatch(/data-mp="category">research</);
  });

  it("shows viewer pills only when authenticated and annotated", () => {
    const owned: GalleryView = { items: [galleryCard({ isOwn: true })], total: 1 };
    const viewer: ViewerContext = { userId: "u-1", handle: "alice" };

    const authed = renderExploreToHtml(owned, viewer, seo("en")).html;
    expect(authed).toContain('data-mp="own-pill"');

    // Anonymous viewer: no pill even though the item is flagged.
    const anon = renderExploreToHtml(owned, ANON, seo("en")).html;
    expect(anon).not.toContain('data-mp="own-pill"');
  });
});

describe("renderDetailToHtml", () => {
  it("emits crawlable semantic detail HTML (article + start command)", () => {
    const { html } = renderDetailToHtml(detailView(), ANON, seo("en"));
    expect(html).toContain('data-mp="detail-article"');
    expect(html).toContain("<article");
    expect(html).toContain("Research Flow");
    expect(html).toContain("start(&quot;alice/research-flow&quot;)");
    expect(html).toContain(`<link rel="canonical" href="${BASE_URL}/w/alice/research-flow" />`);
    expect(html).toContain('<meta property="og:type" content="article" />');
  });

  it("emits a well-formed SoftwareApplication JSON-LD with aggregateRating", () => {
    const { html } = renderDetailToHtml(detailView(), ANON, seo("en"));
    const app = jsonLdBlocks(html)
      .map((b) => JSON.parse(b))
      .find((d) => d["@type"] === "SoftwareApplication");

    expect(app).toBeDefined();
    expect(app["@context"]).toBe("https://schema.org");
    expect(app.name).toBe("Research Flow");
    expect(app.url).toBe(`${BASE_URL}/w/alice/research-flow`);
    expect(app.author).toEqual({ "@type": "Person", name: "alice" });
    expect(app.offers).toEqual({ "@type": "Offer", price: "0", priceCurrency: "USD" });
    expect(app.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: "4.5",
      ratingCount: 6,
    });
  });

  it("omits aggregateRating when there are no ratings", () => {
    const { html } = renderDetailToHtml(
      detailView({ ratingCount: 0, ratingAvg: 0 }),
      ANON,
      seo("en"),
    );
    const app = jsonLdBlocks(html)
      .map((b) => JSON.parse(b))
      .find((d) => d["@type"] === "SoftwareApplication");
    expect(app.aggregateRating).toBeUndefined();
  });

  it("localizes step + install counts (RU declensions) and category", () => {
    const ru = renderDetailToHtml(
      detailView({ stepCount: 2, installCount: 5, category: "data" }),
      ANON,
      seo("ru"),
    ).html;
    expect(ru).toContain("2 шага"); // few
    expect(ru).toContain("5 установок"); // many
    expect(ru).toContain("Данные и анализ"); // category enum localized
    expect(ru).toContain('<html lang="ru">');

    const en = renderDetailToHtml(
      detailView({ stepCount: 1, installCount: 1 }),
      ANON,
      seo("en"),
    ).html;
    expect(en).toContain("1 step");
    expect(en).toContain("1 install");
  });

  it("renders the localized 'Unrated' label for an unrated flow (EN + RU)", () => {
    const en = renderDetailToHtml(detailView({ ratingCount: 0 }), ANON, seo("en")).html;
    expect(en).toContain("Unrated");
    const ru = renderDetailToHtml(detailView({ ratingCount: 0 }), ANON, seo("ru")).html;
    expect(ru).toContain("Без оценок");
  });
});

describe("JSON-LD XSS safety", () => {
  it("a malicious detail title cannot break out of the ld+json script block", () => {
    const malicious = detailView({
      title: "</script><script>alert(1)</script>",
      summary: "evil </script><img src=x onerror=alert(2)>",
    });
    const { html } = renderDetailToHtml(malicious, ANON, seo("en"));

    // The only ld+json scripts must be the legitimate ones; the injected closing tag
    // must be neutralized to </script>, never a raw </script> inside the block.
    const blocks = jsonLdBlocks(html);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const block of blocks) {
      expect(block).not.toContain("</script>");
      // The data is still parseable JSON (escape did not corrupt structure).
      const parsed = JSON.parse(block.replace(/\\u003c/g, "<"));
      expect(parsed["@context"]).toBe("https://schema.org");
    }

    // No raw injected <script>alert(1)</script> anywhere in the output (React escapes
    // the body; serializeJsonLd escapes the head).
    expect(html).not.toContain("<script>alert(1)</script>");
    // The injected <img onerror> must not appear as a live tag: every `<` from user
    // input is escaped (entity in HTML attrs/body, < in JSON-LD), so no raw
    // `<img ` opening tag survives anywhere in the document.
    expect(html).not.toContain("<img src=x onerror=");
  });

  it("a malicious gallery item title cannot break out of the ItemList block", () => {
    const gallery: GalleryView = {
      items: [galleryCard({ title: "</script><script>alert(3)</script>" })],
      total: 1,
    };
    const { html } = renderExploreToHtml(gallery, ANON, seo("en"));
    for (const block of jsonLdBlocks(html)) {
      expect(block).not.toContain("</script>");
    }
    expect(html).not.toContain("<script>alert(3)</script>");
  });
});

describe("ListingDetail action area (session-aware)", () => {
  const VIEWER: ViewerContext = { userId: "u-1", handle: "bob" };

  it("anonymous → gated sign-in CTA, no add-to-library button", () => {
    const { html } = renderDetailToHtml(
      detailView({ isOwn: false, inLibrary: false }),
      ANON,
      seo("en"),
    );
    expect(html).toContain('data-mp="signin-cta"');
    expect(html).not.toContain('data-mp="add-cta"');
  });

  it("signed-in, not own, not in library → add-to-library button, no sign-in CTA", () => {
    const { html } = renderDetailToHtml(
      detailView({ isOwn: false, inLibrary: false }),
      VIEWER,
      seo("en"),
    );
    expect(html).toContain('data-mp="add-cta"');
    expect(html).not.toContain('data-mp="signin-cta"');
  });

  it("signed-in OWNER → own-pill and NO add button (and no sign-in CTA)", () => {
    const { html } = renderDetailToHtml(
      detailView({ isOwn: true, inLibrary: false }),
      VIEWER,
      seo("en"),
    );
    expect(html).toContain('data-mp="own-pill"');
    expect(html).not.toContain('data-mp="add-cta"');
    expect(html).not.toContain('data-mp="signin-cta"');
  });

  it("signed-in, already in library (not own) → library-pill and NO add button", () => {
    const { html } = renderDetailToHtml(
      detailView({ isOwn: false, inLibrary: true }),
      VIEWER,
      seo("en"),
    );
    expect(html).toContain('data-mp="library-pill"');
    expect(html).not.toContain('data-mp="add-cta"');
    expect(html).not.toContain('data-mp="signin-cta"');
  });
});
