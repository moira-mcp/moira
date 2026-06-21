import path from "path";
import { fileURLToPath } from "url";

import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

import sitemap from "@astrojs/sitemap";
import mdx from "@astrojs/mdx";
import icon from "astro-icon";
import compress from "astro-compress";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import { loadEnv } from "vite";

import {
  readingTimeRemarkPlugin,
  responsiveTablesRehypePlugin,
  lazyImagesRehypePlugin,
  staticDomainRemarkPlugin,
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

const { MOIRA_HOST, CONTACT_EMAIL, STATIC_ARTIFACTS_DOMAIN } = loadEnv("", process.cwd(), "");
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
          items: [
            {
              label: "Introduction",
              slug: "docs/getting-started/introduction",
            },
            { label: "Quick Start", slug: "docs/getting-started/quickstart" },
            { label: "Self-Hosting", slug: "docs/getting-started/self-hosting" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Workflows", slug: "docs/concepts/workflows" },
            { label: "Nodes", slug: "docs/concepts/nodes" },
            { label: "Templates", slug: "docs/concepts/templates" },
            { label: "Notes", slug: "docs/concepts/notes" },
            { label: "Artifacts", slug: "docs/concepts/artifacts" },
          ],
        },
        {
          label: "Patterns",
          items: [
            { label: "Overview", slug: "docs/patterns" },
            {
              label: "Information Collection",
              slug: "docs/patterns/information-collection",
            },
            { label: "Skip Pattern", slug: "docs/patterns/skip" },
            { label: "Validation Loop", slug: "docs/patterns/validation-loop" },
            { label: "Branching", slug: "docs/patterns/branching" },
            { label: "Dynamic Files", slug: "docs/patterns/dynamic-files" },
            {
              label: "Step Verification",
              slug: "docs/patterns/step-verification",
            },
            { label: "Escalation", slug: "docs/patterns/escalation" },
            { label: "Subagent Review", slug: "docs/patterns/subagent-review" },
            { label: "Replan", slug: "docs/patterns/replan" },
            { label: "Self Review", slug: "docs/patterns/self-review" },
            { label: "Workspace", slug: "docs/patterns/workspace" },
            {
              label: "Notes Persistence",
              slug: "docs/patterns/notes-persistence",
            },
            {
              label: "Artifacts Publishing",
              slug: "docs/patterns/artifacts-publishing",
            },
            {
              label: "Anti-patterns",
              slug: "docs/patterns/anti-patterns",
            },
            {
              label: "Static Configuration",
              slug: "docs/patterns/static-configuration",
            },
          ],
        },
        {
          label: "Guides",
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
              label: "Workflow Templates",
              slug: "docs/reference/workflow-templates",
            },
            { label: "Validation", slug: "docs/reference/validation" },
          ],
        },
        {
          label: "Workflow Catalog",
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

    compress({
      CSS: true,
      HTML: {
        "html-minifier-terser": {
          removeAttributeQuotes: false,
        },
      },
      Image: false,
      JavaScript: true,
      SVG: false,
      Logger: 1,
    }),
  ],

  markdown: {
    remarkPlugins: [readingTimeRemarkPlugin, staticDomainRemarkPlugin],
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
