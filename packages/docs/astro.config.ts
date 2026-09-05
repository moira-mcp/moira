import path from "path";
import { fileURLToPath } from "url";

import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

import sitemap from "@astrojs/sitemap";
import mdx from "@astrojs/mdx";
import icon from "astro-icon";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import { loadEnv } from "vite";

import {
  readingTimeRemarkPlugin,
  responsiveTablesRehypePlugin,
  lazyImagesRehypePlugin,
  portableHelpRemarkPlugin,
} from "./src/utils/frontmatter";
import {
  getMcpUrl,
  setHost,
  getContactEmail,
  setContactEmail,
  getStaticArtifactsDomain,
  setStaticArtifactsDomain,
} from "@mcp-moira/shared/urls";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const localAppEnv = loadEnv("development", path.resolve(__dirname, "../.."), "");
const docsEnv = loadEnv("", process.cwd(), "");
const { MOIRA_HOST, CONTACT_EMAIL, STATIC_ARTIFACTS_DOMAIN } = {
  ...localAppEnv,
  ...docsEnv,
};
setHost(MOIRA_HOST);
// CONTACT_EMAIL is optional in self-host (DEPLOYMENT_MODE=self-host) — getContactEmail()
// falls back to support@localhost. Push the raw value into the env first so the
// getter can apply the mode-aware fallback instead of throwing on an empty string.
if (CONTACT_EMAIL) process.env.CONTACT_EMAIL = CONTACT_EMAIL;
setContactEmail(getContactEmail());
setStaticArtifactsDomain(STATIC_ARTIFACTS_DOMAIN);

export default defineConfig({
  output: "static",

  integrations: [
    mermaid(),
    starlight({
      title: "Moira Documentation",
      description: "Agent Workflow Engine - Documentation",
      favicon: "/favicon.ico",
      defaultLocale: "root",
      locales: {
        root: {
          label: "English",
          lang: "en",
        },
        ru: {
          label: "Русский",
          lang: "ru",
        },
      },
      sidebar: [
        {
          label: "Getting Started",
          translations: { ru: "Начало работы" },
          items: [
            {
              label: "Introduction",
              translations: { ru: "Введение" },
              slug: "docs/getting-started/introduction",
            },
            {
              label: "Quick Start",
              translations: { ru: "Быстрый старт" },
              slug: "docs/getting-started/quickstart",
            },
            {
              label: "Self-Hosting",
              translations: { ru: "Самостоятельный хостинг" },
              slug: "docs/getting-started/self-hosting",
            },
          ],
        },
        {
          label: "Concepts",
          translations: { ru: "Концепции" },
          items: [
            {
              label: "Workflows",
              translations: { ru: "Воркфлоу" },
              slug: "docs/concepts/workflows",
            },
            {
              label: "Nodes",
              translations: { ru: "Ноды" },
              slug: "docs/concepts/nodes",
            },
            {
              label: "Templates",
              translations: { ru: "Шаблоны" },
              slug: "docs/concepts/templates",
            },
            {
              label: "Notes",
              translations: { ru: "Заметки" },
              slug: "docs/concepts/notes",
            },
            {
              label: "Artifacts",
              translations: { ru: "Артефакты" },
              slug: "docs/concepts/artifacts",
            },
          ],
        },
        {
          label: "Patterns",
          translations: { ru: "Паттерны" },
          items: [
            { label: "Overview", translations: { ru: "Обзор" }, slug: "docs/patterns" },
            {
              label: "Minimal Graph",
              translations: { ru: "Минимальный граф" },
              slug: "docs/patterns/minimal-graph",
            },
            {
              label: "Information Collection",
              translations: { ru: "Сбор информации" },
              slug: "docs/patterns/information-collection",
            },
            {
              label: "Skip Pattern",
              translations: { ru: "Пропуск" },
              slug: "docs/patterns/skip",
            },
            {
              label: "Validation Loop",
              translations: { ru: "Цикл валидации" },
              slug: "docs/patterns/validation-loop",
            },
            {
              label: "Repair Reach",
              translations: { ru: "Область исправления" },
              slug: "docs/patterns/repair-reach",
            },
            {
              label: "Branching",
              translations: { ru: "Ветвление" },
              slug: "docs/patterns/branching",
            },
            {
              label: "Dynamic Files",
              translations: { ru: "Динамические файлы" },
              slug: "docs/patterns/dynamic-files",
            },
            {
              label: "Step Verification",
              translations: { ru: "Проверка шага" },
              slug: "docs/patterns/step-verification",
            },
            {
              label: "Escalation",
              translations: { ru: "Эскалация" },
              slug: "docs/patterns/escalation",
            },
            {
              label: "Subagent Review",
              translations: { ru: "Ревью субагентом" },
              slug: "docs/patterns/subagent-review",
            },
            {
              label: "Process Revision",
              translations: { ru: "Пересмотр процесса" },
              slug: "docs/patterns/process-revision",
            },
            {
              label: "Replan",
              translations: { ru: "Перепланирование" },
              slug: "docs/patterns/replan",
            },
            {
              label: "Operating Mode",
              translations: { ru: "Режим работы" },
              slug: "docs/patterns/operating-mode",
            },
            {
              label: "Self Review",
              translations: { ru: "Самопроверка" },
              slug: "docs/patterns/self-review",
            },
            {
              label: "Workspace",
              translations: { ru: "Рабочая область" },
              slug: "docs/patterns/workspace",
            },
            {
              label: "Notes Persistence",
              translations: { ru: "Хранение заметок" },
              slug: "docs/patterns/notes-persistence",
            },
            {
              label: "Artifacts Publishing",
              translations: { ru: "Публикация артефактов" },
              slug: "docs/patterns/artifacts-publishing",
            },
            {
              label: "Anti-patterns",
              translations: { ru: "Антипаттерны" },
              slug: "docs/patterns/anti-patterns",
            },
            {
              label: "Static Configuration",
              translations: { ru: "Статическая конфигурация" },
              slug: "docs/patterns/static-configuration",
            },
          ],
        },
        {
          label: "Guides",
          translations: { ru: "Руководства" },
          items: [
            {
              label: "Creating Workflows",
              slug: "docs/guides/workflow-creation",
            },
            {
              label: "Writing Directives",
              slug: "docs/guides/writing-directives",
            },
            {
              label: "Editing Workflows",
              slug: "docs/guides/editing-workflows",
            },
          ],
        },
        {
          label: "Integration",
          translations: { ru: "Интеграция" },
          items: [
            { label: "Claude Code", slug: "docs/integration/claude-code" },
            { label: "MCP Clients", slug: "docs/integration/mcp-clients" },
            { label: "Agent Guide", slug: "docs/integration/agent-guide" },
            {
              label: "Agent Instructions",
              slug: "docs/integration/agent-instructions",
            },
            { label: "Telegram Setup", slug: "docs/integration/telegram-setup" },
            { label: "Troubleshooting", slug: "docs/integration/troubleshooting" },
          ],
        },
        {
          label: "Reference",
          translations: { ru: "Справочник" },
          items: [
            { label: "MCP Tools", slug: "docs/reference/tools" },
            {
              label: "Condition Operators",
              slug: "docs/reference/condition-operators",
            },
            { label: "Input Schema", slug: "docs/reference/input-schema" },
            {
              label: "Magic Variables",
              slug: "docs/reference/magic-variables",
            },
            {
              label: "Materialize Files",
              slug: "docs/reference/materialize",
            },
            {
              label: "Workflow Templates",
              slug: "docs/reference/workflow-templates",
            },
            { label: "Validation", slug: "docs/reference/validation" },
          ],
        },
        {
          label: "Workflow Catalog",
          translations: { ru: "Каталог воркфлоу" },
          items: [
            {
              label: "Content Creation",
              slug: "docs/reference/workflows/content-creation",
            },
            { label: "Verified Research", slug: "docs/reference/workflows/verified-research" },
            { label: "Iterative Research", slug: "docs/reference/workflows/iterative-research" },
            {
              label: "PRD Creation",
              slug: "docs/reference/workflows/prd-creation",
            },
            { label: "UX Design", slug: "docs/reference/workflows/ux-design" },
            {
              label: "Test Generation",
              slug: "docs/reference/workflows/test-generation",
            },
            {
              label: "Test Planning",
              slug: "docs/reference/workflows/test-planning",
            },
            {
              label: "Data Analysis",
              slug: "docs/reference/workflows/data-analysis",
            },
            {
              label: "Marketing Campaign",
              slug: "docs/reference/workflows/marketing-campaign",
            },
            {
              label: "Quick Task",
              slug: "docs/reference/workflows/quick-task",
            },
            {
              label: "Robust Task",
              slug: "docs/reference/workflows/robust-task",
            },
            {
              label: "Todo List",
              slug: "docs/reference/workflows/todo-list",
            },
          ],
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/moira-mcp/moira",
        },
      ],
      customCss: ["./src/styles/starlight.css"],
      disable404Route: true,
    }),
    sitemap(),
    mdx(),
    icon({
      include: {
        tabler: ["*"],
        "flat-color-icons": [
          "template",
          "gallery",
          "approval",
          "document",
          "advertising",
          "currency-exchange",
          "voice-presentation",
          "business-contact",
          "database",
        ],
      },
    }),
  ],

  markdown: {
    remarkPlugins: [readingTimeRemarkPlugin, portableHelpRemarkPlugin],
    rehypePlugins: [responsiveTablesRehypePlugin, lazyImagesRehypePlugin],
  },

  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        "~": path.resolve(__dirname, "./src"),
      },
    },
    define: {
      MoiraConfig: { mcpUrl: getMcpUrl(), staticDomain: getStaticArtifactsDomain() },
    },
  },
});
