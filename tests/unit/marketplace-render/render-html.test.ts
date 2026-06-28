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
    listingId: "listing-1",
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
    listingId: "listing-1",
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
  it("emits crawlable semantic detail HTML (article + human run instruction, no MCP code)", () => {
    const { html } = renderDetailToHtml(detailView(), ANON, seo("en"));
    expect(html).toContain('data-mp="detail-article"');
    expect(html).toContain("<article");
    expect(html).toContain("Research Flow");
    // Human "how to use" model — a natural-language run instruction by title, NOT a
    // developer `start(...)` MCP command (Moira's end user does not execute MCP tools).
    expect(html).toContain('data-mp="run-instruction"');
    expect(html).toContain("run “Research Flow”");
    expect(html).not.toContain('start("alice/research-flow")');
    expect(html).not.toContain("start(&quot;alice/research-flow&quot;)");
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
    expect(html).not.toContain('data-mp="adopt-btn"');
  });

  it("signed-in, not own, not in library → add-to-library button, no sign-in CTA", () => {
    const { html } = renderDetailToHtml(
      detailView({ isOwn: false, inLibrary: false }),
      VIEWER,
      seo("en"),
    );
    expect(html).toContain('data-mp="adopt-btn"');
    expect(html).toContain("Add to library");
    expect(html).not.toContain('data-mp="signin-cta"');
  });

  it("signed-in OWNER → own-pill and NO add button (and no sign-in CTA)", () => {
    const { html } = renderDetailToHtml(
      detailView({ isOwn: true, inLibrary: false }),
      VIEWER,
      seo("en"),
    );
    expect(html).toContain('data-mp="own-pill"');
    expect(html).not.toContain('data-mp="adopt-btn"');
    expect(html).not.toContain('data-mp="signin-cta"');
  });

  it("signed-in, already in library (not own) → library-pill and NO add button", () => {
    const { html } = renderDetailToHtml(
      detailView({ isOwn: false, inLibrary: true }),
      VIEWER,
      seo("en"),
    );
    expect(html).toContain('data-mp="library-pill"');
    expect(html).not.toContain('data-mp="adopt-btn"');
    expect(html).not.toContain('data-mp="signin-cta"');
  });

  it("renders a JS-free Download link to the public export endpoint (any viewer)", () => {
    const anon = renderDetailToHtml(detailView(), ANON, seo("en")).html;
    expect(anon).toContain('data-mp="download-link"');
    expect(anon).toContain(
      `href="${BASE_URL}/api/public/marketplace/listings/alice/research-flow/export"`,
    );
    expect(anon).toContain("Download");
    // The download link is present for an owner too (export is the self-host source).
    const owner = renderDetailToHtml(detailView({ isOwn: true }), VIEWER, seo("en")).html;
    expect(owner).toContain('data-mp="download-link"');
  });
});

describe("ExploreGallery Official filter chips", () => {
  it("renders All + Official chips as crawlable links with the active state from the filter", () => {
    const gallery: GalleryView = { items: [galleryCard()], total: 1 };

    // Default (no filter) → All active.
    const all = renderExploreToHtml(gallery, ANON, seo("en")).html;
    expect(all).toContain('data-mp="filter-chips"');
    expect(all).toContain('data-mp="chip-all"');
    expect(all).toContain('data-mp="chip-official"');
    expect(all).toContain(`href="${BASE_URL}/explore?official=true"`);
    // All chip active, Official chip not.
    expect(all).toMatch(/data-mp="chip-all"[^>]*aria-pressed="true"/);
    expect(all).toMatch(/data-mp="chip-official"[^>]*aria-pressed="false"/);

    // Official filter active → Official chip pressed.
    const official = renderExploreToHtml(gallery, ANON, seo("en"), { official: true }).html;
    expect(official).toMatch(/data-mp="chip-official"[^>]*aria-pressed="true"/);
    expect(official).toMatch(/data-mp="chip-all"[^>]*aria-pressed="false"/);
  });

  it("localizes the chip labels and carries ?lang in the chip hrefs (RU)", () => {
    const gallery: GalleryView = { items: [galleryCard()], total: 1 };
    const ru = renderExploreToHtml(gallery, ANON, seo("ru"), { official: false }).html;
    expect(ru).toContain("Все");
    expect(ru).toContain("Официальные");
    // Official chip carries BOTH filter + language (React escapes `&` → `&amp;` in attrs).
    expect(ru).toContain(`href="${BASE_URL}/explore?official=true&amp;lang=ru"`);
  });
});

describe("ListingCard adopt + download affordances", () => {
  const VIEWER: ViewerContext = { userId: "u-1", handle: "bob" };

  it("a signed-in addable card shows the adopt button + a public download link", () => {
    const gallery: GalleryView = {
      items: [galleryCard({ isOwn: false, inLibrary: false })],
      total: 1,
    };
    const html = renderExploreToHtml(gallery, VIEWER, seo("en")).html;
    expect(html).toContain('data-mp="adopt-btn"');
    expect(html).toContain('data-mp="download-link"');
  });

  it("an in-library card shows the download link but NO adopt button", () => {
    const gallery: GalleryView = {
      items: [galleryCard({ isOwn: false, inLibrary: true })],
      total: 1,
    };
    const html = renderExploreToHtml(gallery, VIEWER, seo("en")).html;
    expect(html).not.toContain('data-mp="adopt-btn"');
    expect(html).toContain('data-mp="download-link"');
  });

  it("an anonymous card shows the download link but NO adopt button", () => {
    const gallery: GalleryView = { items: [galleryCard()], total: 1 };
    const html = renderExploreToHtml(gallery, ANON, seo("en")).html;
    expect(html).not.toContain('data-mp="adopt-btn"');
    expect(html).toContain('data-mp="download-link"');
  });
});

describe("ExploreGallery empty-state (Step 9, D-N11)", () => {
  it("a truly empty catalog shows the catalog-empty copy, not the search copy", () => {
    const empty: GalleryView = { items: [], total: 0 };
    const html = renderExploreToHtml(empty, ANON, seo("en")).html;
    expect(html).toContain('data-mp="empty"');
    expect(html).toContain("No published workflows yet.");
    expect(html).not.toContain('data-mp="empty-search"');
    expect(html).not.toContain('data-mp="clear-search"');
    // No active filter → the count uses the "published" wording, not "results".
    expect(html).toMatch(/data-mp="total"[^>]*>0 published</);
  });

  it("a no-results SEARCH shows search-specific copy + a clear link, not 'no published'", () => {
    const empty: GalleryView = { items: [], total: 0 };
    const html = renderExploreToHtml(empty, ANON, seo("en"), {
      official: false,
      search: "zzzznomatch",
    }).html;
    expect(html).toContain('data-mp="empty-search"');
    expect(html).toContain("No workflows match your filters.");
    expect(html).not.toContain("No published workflows yet.");
    // The clear link drops the search back to the unfiltered catalog.
    expect(html).toContain('data-mp="clear-search"');
    expect(html).toContain(`href="${BASE_URL}/explore"`);
    // Filtered → the count uses the "results" wording (0 results, not "0 published").
    expect(html).toMatch(/data-mp="total"[^>]*>0 results</);
  });

  it("a no-results OFFICIAL filter (no search) also shows the no-match state + clear link", () => {
    const empty: GalleryView = { items: [], total: 0 };
    const html = renderExploreToHtml(empty, ANON, seo("en"), { official: true }).html;
    expect(html).toContain('data-mp="empty-search"');
    expect(html).toContain('data-mp="clear-search"');
    expect(html).toMatch(/data-mp="total"[^>]*>0 results</);
  });

  it("RU: filtered count uses the 'результат' declensions", () => {
    const five: GalleryView = { items: [], total: 0 };
    const ru = renderExploreToHtml(five, ANON, seo("ru"), { official: true }).html;
    expect(ru).toMatch(/data-mp="total"[^>]*>0 результат/);
    expect(ru).toContain("Нет воркфлоу по вашему запросу.");
  });
});

describe("ExploreGallery partition-aware chips (Step 9, D-N8)", () => {
  const gallery: GalleryView = { items: [galleryCard()], total: 1 };

  it("renders three partition chips (All / Official / Community) with their facet counts", () => {
    const html = renderExploreToHtml(gallery, ANON, seo("en"), { official: false }, {
      all: 12,
      official: 9,
      community: 3,
    }).html;
    expect(html).toContain('data-mp="chip-all"');
    expect(html).toContain('data-mp="chip-official"');
    expect(html).toContain('data-mp="chip-community"');
    // Each chip carries its count (All=12, Official=9, Community=3 → partition sums).
    expect(html).toMatch(/data-mp="chip-all"[\s\S]*?data-mp="chip-count">12</);
    expect(html).toMatch(/data-mp="chip-official"[\s\S]*?data-mp="chip-count">9</);
    expect(html).toMatch(/data-mp="chip-community"[\s\S]*?data-mp="chip-count">3</);
    // Community chip is a crawlable link to the community partition.
    expect(html).toContain(`href="${BASE_URL}/explore?community=true"`);
  });

  it("marks the Community chip active when the community filter is set", () => {
    const html = renderExploreToHtml(gallery, ANON, seo("en"), { official: false, community: true })
      .html;
    expect(html).toMatch(/data-mp="chip-community"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-mp="chip-all"[^>]*aria-pressed="false"/);
    expect(html).toMatch(/data-mp="chip-official"[^>]*aria-pressed="false"/);
  });

  it("chip links preserve the active search term across partitions", () => {
    const html = renderExploreToHtml(gallery, ANON, seo("en"), {
      official: false,
      search: "research",
    }).html;
    // Switching to Official/Community keeps ?search; React escapes & → &amp; in attrs.
    expect(html).toContain(`href="${BASE_URL}/explore?official=true&amp;search=research"`);
    expect(html).toContain(`href="${BASE_URL}/explore?community=true&amp;search=research"`);
    // The All chip keeps the search too.
    expect(html).toContain(`href="${BASE_URL}/explore?search=research"`);
  });

  it("omits chip counts when no facets are provided (counts are optional)", () => {
    const html = renderExploreToHtml(gallery, ANON, seo("en"), { official: false }).html;
    expect(html).toContain('data-mp="chip-all"');
    expect(html).not.toContain('data-mp="chip-count"');
  });
});
