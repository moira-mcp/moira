/**
 * Docs package structure tests.
 *
 * Guards the `packages/docs` Starlight site after its extraction from
 * `packages/landing-page`:
 * - the docs content lives at the new location (the path get_help + the Dockerfile
 *   COPY and the astro build all depend on),
 * - EN and RU doc trees are in parity (same relative file set),
 * - every sidebar slug declared in the docs astro.config resolves to a real EN
 *   `.mdx` file (a missing slug would 404 in the built site).
 */

import { describe, test, expect } from "@jest/globals";
import fs from "fs";
import path from "path";

const REPO_ROOT = process.cwd();
const DOCS_PKG = path.join(REPO_ROOT, "packages/docs");
const EN_DIR = path.join(DOCS_PKG, "src/content/docs/docs");
const RU_DIR = path.join(DOCS_PKG, "src/content/docs/ru/docs");
const ASTRO_CONFIG = path.join(DOCS_PKG, "astro.config.ts");

function listMdx(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else if (entry.name.endsWith(".mdx")) out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

describe("docs package structure", () => {
  test("docs content lives in packages/docs (not landing-page)", () => {
    expect(fs.existsSync(EN_DIR)).toBe(true);
    expect(fs.existsSync(RU_DIR)).toBe(true);
    // The old landing-page docs location must be gone after the move.
    expect(fs.existsSync(path.join(REPO_ROOT, "packages/landing-page/src/content/docs"))).toBe(
      false,
    );
  });

  test("EN and RU docs are in parity (same relative file set)", () => {
    const en = listMdx(EN_DIR);
    const ru = listMdx(RU_DIR);
    expect(en.length).toBeGreaterThan(0);
    expect(ru).toEqual(en);
  });

  test("every sidebar slug in astro.config resolves to a real EN .mdx file", () => {
    const config = fs.readFileSync(ASTRO_CONFIG, "utf-8");
    // Extract slugs like `slug: "docs/getting-started/quickstart"`.
    const slugs = [...config.matchAll(/slug:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(slugs.length).toBeGreaterThan(0);

    for (const slug of slugs) {
      // Slugs are "docs/<rel>"; the EN file is EN_DIR/<rel>.mdx (or <rel>/index.mdx).
      const rel = slug.replace(/^docs\//, "");
      const asFile = path.join(EN_DIR, `${rel}.mdx`);
      const asIndex = path.join(EN_DIR, rel, "index.mdx");
      expect(fs.existsSync(asFile) || fs.existsSync(asIndex)).toBe(true);
    }
  });
});
