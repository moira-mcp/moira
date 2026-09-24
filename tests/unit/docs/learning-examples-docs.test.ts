/**
 * The tutorial and the reference pages quote the learning flows word for word: every instruction
 * the agent receives and every answer label of a fork appears on the page of the same language.
 * A flow whose text is edited without its pages — or a page that paraphrases a step — fails here,
 * so what a reader is told the agent will see is what the agent is actually given.
 */

import { describe, expect, test } from "@jest/globals";
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const FLOWS = path.join(ROOT, "workflows/production/flows");
const DOCS = {
  en: path.join(ROOT, "packages/docs/src/content/docs/docs"),
  ru: path.join(ROOT, "packages/docs/src/content/docs/ru/docs"),
};
/** The getting-started pages are MCP help topics; the docs pages only import them. */
const HELP = {
  en: path.join(ROOT, "packages/mcp-server/src/help/content"),
  ru: path.join(ROOT, "packages/mcp-server/src/help/content/ru"),
};
const LEVELS = ["example-simple-steps", "example-one-choice", "example-several-paths"];

type FlowNode = {
  type: string;
  directive?: string;
  connections?: Record<string, string>;
  connectionLabels?: Record<string, string>;
};

function flow(slug: string): { nodes: FlowNode[] } {
  for (const file of fs.readdirSync(FLOWS)) {
    const workflow = JSON.parse(fs.readFileSync(path.join(FLOWS, file), "utf8"));
    if (workflow.slug === slug) return workflow;
  }
  throw new Error(`no catalog flow ${slug}`);
}

/** Everything a reader should find quoted: the directives, and the labels of a fork's ways out. */
function quotedTexts(slug: string): string[] {
  return flow(slug).nodes.flatMap((node) => [
    ...(node.type === "agent-directive" && node.directive ? [node.directive] : []),
    ...(Object.keys(node.connections ?? {}).length > 1
      ? Object.values(node.connectionLabels ?? {})
      : []),
  ]);
}

const squash = (text: string): string => text.replace(/\s+/g, " ");

function page(lang: "en" | "ru", relative: string): string {
  return squash(fs.readFileSync(path.join(DOCS[lang], relative), "utf8"));
}

function helpTopic(lang: "en" | "ru", relative: string): string {
  return squash(fs.readFileSync(path.join(HELP[lang], relative), "utf8"));
}

describe.each([
  ["en", ""],
  ["ru", "-ru"],
] as const)("learning examples on the %s pages", (lang, suffix) => {
  const tutorial = helpTopic(lang, "getting-started/tutorial.md");

  test.each(LEVELS)("the tutorial quotes every step and answer of %s", (level) => {
    const slug = `${level}${suffix}`;
    expect(tutorial).toContain(`moira/${slug}`);
    const missing = quotedTexts(slug).filter((text) => !tutorial.includes(squash(text)));
    expect(missing).toEqual([]);
  });

  test.each(LEVELS)("the reference page of %s quotes every step", (level) => {
    const slug = `${level}${suffix}`;
    const reference = page(lang, `reference/workflows/${slug}.mdx`);
    const missing = quotedTexts(slug).filter((text) => !reference.includes(squash(text)));
    expect(missing).toEqual([]);
  });

  test("the quick start runs the first example in this language", () => {
    const quickstart = helpTopic(lang, "getting-started/quickstart.after.md");
    expect(quickstart).toContain(`moira/example-simple-steps${suffix}`);
  });
});
