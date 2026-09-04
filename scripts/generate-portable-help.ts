import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderClientSetupMarkdown } from "../packages/docs/src/utils/client-setup-markdown.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helpDirectory = path.join(projectRoot, "packages/docs/src/fragments/help");
const outputDirectory = path.join(helpDirectory, "generated");
const placeholderUrl = "{MCP_URL}";
const clientSetup = {
  en: renderClientSetupMarkdown("en", placeholderUrl),
  ru: renderClientSetupMarkdown("ru", placeholderUrl),
};
const stripFrontmatter = (content: string): string =>
  content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "").trim();
const systemPrompt = {
  en: stripFrontmatter(
    fs.readFileSync(
      path.join(projectRoot, "packages/docs/src/content/docs/docs/SYSTEM-PROMPT.md"),
      "utf8",
    ),
  ),
  ru: stripFrontmatter(
    fs.readFileSync(
      path.join(projectRoot, "packages/docs/src/content/docs/docs/SYSTEM-PROMPT-RU.md"),
      "utf8",
    ),
  ),
};
const expected = new Map<string, string>([
  [path.join(outputDirectory, "client-setup.en.md"), clientSetup.en],
  [path.join(outputDirectory, "client-setup.ru.md"), clientSetup.ru],
]);
const normalizeSplitFragment = (content: string): string => `${content.trim()}\n`;

for (const language of ["en", "ru"] as const) {
  const prefix = language === "ru" ? "ru/" : "";
  for (const relativePath of ["getting-started/quickstart.md", "integration/mcp-clients.md"]) {
    const outputPath = path.join(helpDirectory, prefix, relativePath);
    const template = fs.readFileSync(`${outputPath}.in`, "utf8");
    const marker = `{{CLIENT_SETUP:${language}}}`;
    const parts = template.split(marker);
    if (parts.length !== 2) throw new Error(`Expected one ${marker} in ${outputPath}.in`);
    expected.set(outputPath, template.replace(marker, clientSetup[language].trim()));
    expected.set(
      outputPath.replace(/\.md$/, ".public-before.md"),
      normalizeSplitFragment(parts[0]),
    );
    expected.set(outputPath.replace(/\.md$/, ".public-after.md"), normalizeSplitFragment(parts[1]));
  }
  const agentInstructions = path.join(helpDirectory, prefix, "integration/agent-instructions.md");
  const agentTemplate = fs.readFileSync(`${agentInstructions}.in`, "utf8");
  const agentMarker = `{{SYSTEM_PROMPT_CONTENT:${language}}}`;
  const agentParts = agentTemplate.split(agentMarker);
  if (agentParts.length !== 2) {
    throw new Error(`Expected one ${agentMarker} in ${agentInstructions}.in`);
  }
  expected.set(agentInstructions, agentTemplate.replace(agentMarker, systemPrompt[language]));
  expected.set(
    agentInstructions.replace(/\.md$/, ".public-before.md"),
    normalizeSplitFragment(agentParts[0]),
  );
  expected.set(
    agentInstructions.replace(/\.md$/, ".public-after.md"),
    normalizeSplitFragment(agentParts[1]),
  );
}
const check = process.argv.includes("--check");

if (check) {
  const stale = [...expected].filter(([filePath, content]) => {
    return !fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8") !== content;
  });
  if (stale.length > 0) {
    throw new Error(
      `Generated portable help is stale: ${stale
        .map(([filePath]) => path.relative(projectRoot, filePath))
        .join(", ")}`,
    );
  }
} else {
  for (const [filePath, content] of expected) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}
