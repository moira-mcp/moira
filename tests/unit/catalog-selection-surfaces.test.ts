import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { _testing as helpTesting } from "../../packages/mcp-server/src/tools/get-help.js";

const root = process.cwd();
const workflowsDir = path.join(root, "workflows/production/flows");
const englishDocsDir = path.join(root, "packages/docs/src/content/docs/docs/reference/workflows");
const russianDocsDir = path.join(
  root,
  "packages/docs/src/content/docs/ru/docs/reference/workflows",
);
const helpContentDir = path.join(root, "packages/mcp-server/src/help/content");

const expectedPublicSlugs = [
  "architecture-design-flow",
  "content-creation",
  "data-analysis",
  "deep-corpus-research",
  "execution-retrospective",
  "infinite-task-loop",
  "iterative-research",
  "marketing-campaign",
  "prd-creation",
  "quick-task",
  "robust-task",
  "simple-plan-execution",
  "smart-purchase-assistant",
  "software-development-flow",
  "software-development-flow-lite",
  "startup-idea-validation",
  "task-breakdown-flow",
  "telegram-setup",
  "test-generation",
  "test-planning",
  "test-suite-audit",
  "todo-list",
  "universal-research-workflow",
  "user-onboarding",
  "ux-design",
  "verified-research",
  "workflow-management-flow",
  "workflow-presentation-generator",
].sort();

const removedPublicSlugs = [
  "artifacts-demo-dashboard-builder",
  "artifacts-demo-report-publisher",
  "notes-demo-metrics-collector",
  "notes-demo-metrics-reporter",
  "bug-hunting-workflow",
  "research",
];

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("public workflow selection surfaces", () => {
  it("keeps the production catalog and both documentation locales complete", () => {
    const actualSlugs = fs
      .readdirSync(workflowsDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(fs.readFileSync(path.join(workflowsDir, file), "utf8")).slug)
      .sort();

    expect(actualSlugs).toEqual(expectedPublicSlugs);

    const catalogIndexes = [englishDocsDir, russianDocsDir].map((docsDir) =>
      fs.readFileSync(path.join(docsDir, "index.mdx"), "utf8"),
    );

    for (const slug of expectedPublicSlugs) {
      for (const docsDir of [englishDocsDir, russianDocsDir]) {
        const reference = fs.readFileSync(path.join(docsDir, `${slug}.mdx`), "utf8");
        expect(reference).toMatch(/^---\n[\s\S]*?^title:\s*.+$/m);
        expect(reference).toMatch(/^description:\s*.+$/m);
        expect(reference).toContain(`moira/${slug}`);
      }
      for (const catalogIndex of catalogIndexes) {
        expect(catalogIndex).toContain(`href="./${slug}/"`);
      }
    }
  });

  it("maps every current workflow in MCP help after dynamic discovery", () => {
    const help = helpTesting.getTopicList();

    expect(help).toContain("complete authorized catalog with `list()`");
    for (const slug of expectedPublicSlugs) {
      expect(help).toContain(`\`moira/${slug}\``);
    }
    expect(help).toContain(
      "product selection with current prices/terms, profile-specific recommendations",
    );
    expect(help).toContain("start with `skipTelegramCheck: true`");
  });

  it("keeps runtime English prompts identical and selection dynamic in both languages", () => {
    const configPrompt = read("config/prompts/systemPrompt.md");
    const rootPrompt = read("docs/SYSTEM-PROMPT.md");
    const packagedPrompt = read("packages/docs/src/content/docs/docs/SYSTEM-PROMPT.md");
    const russianPrompt = read("packages/docs/src/content/docs/docs/SYSTEM-PROMPT-RU.md");

    expect(rootPrompt).toBe(configPrompt);
    expect(packagedPrompt).toBe(configPrompt);
    expect(configPrompt).toContain("complete current `list()` result");
    expect(configPrompt).toContain('session({ action: "add-reminder", ... })');
    expect(configPrompt).toContain("active reminders only when that workflow completes");
    expect(configPrompt).toContain("neither performs nor authorizes it");
    expect(configPrompt).not.toContain(
      "Use one software-development workflow for one complete repository implementation lifecycle",
    );
    expect(russianPrompt).toContain("полный текущий результат `list()`");
    expect(russianPrompt).not.toContain("Доступные публичные Workflow");
    expect(russianPrompt).not.toContain("Кодовое слово для отладки");
    expect(russianPrompt).not.toContain("полного жизненного цикла реализации в репозитории");
  });

  it("does not advertise removed identities on live selection surfaces", () => {
    const liveSelectionText = [
      read("config/prompts/systemPrompt.md"),
      read("docs/SYSTEM-PROMPT.md"),
      read("docs/WORKFLOWS.md"),
      read("packages/docs/src/content/docs/docs/SYSTEM-PROMPT.md"),
      read("packages/docs/src/content/docs/docs/SYSTEM-PROMPT-RU.md"),
      read("packages/docs/src/content/docs/docs/reference/workflows/index.mdx"),
      read("packages/docs/src/content/docs/ru/docs/reference/workflows/index.mdx"),
      read("workflows/production/flows/a1838a9a-d3a5-448e-aae1-18e15eeb8286.json"),
      helpTesting.getTopicList(),
    ].join("\n");

    for (const slug of removedPublicSlugs) {
      expect(liveSelectionText).not.toContain(`moira/${slug}`);
    }
    expect(read("docs/WORKFLOWS.md")).toContain("Do not maintain a copied catalog");
  });

  it("keeps the workflow-template guide dynamic and its examples qualified", () => {
    const guides = [
      helpTesting.composePortableHelpFile("reference/workflow-templates.md", {
        helpDirectory: helpContentDir,
      }),
      helpTesting.composePortableHelpFile("ru/reference/workflow-templates.md", {
        helpDirectory: helpContentDir,
      }),
    ];

    for (const guide of guides) {
      expect(guide).not.toBeNull();
      expect(guide).toContain("mcp__moira__list");
      expect(guide).toContain('workflowId: "moira/quick-task"');
      expect(guide).toContain('workflowId: "moira/smart-purchase-assistant"');
      expect(guide).toContain("skipTelegramCheck: true");
      expect(guide).not.toMatch(/workflowId: "(?!moira\/)/);
      expect(guide).not.toContain("Min 3 sources");
      expect(guide).not.toContain("2 tests per category");
      expect(guide).not.toContain("CRISP-DM");
    }
  });
});
