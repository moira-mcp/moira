/**
 * MCP Tool: Get Help
 * Provides on-demand documentation for workflows, tools, and system concepts
 * Discovers topics and serves content from the MCP-owned portable Markdown corpus
 *
 * Semantic topics are discovered dynamically from the filesystem; direct contract topics are
 * represented explicitly in the same catalog:
 * - Scans the local help corpus (excluding ru/ translations and insertion suffixes)
 * - Generates topic IDs from file paths
 * - Extracts metadata (title, description) from frontmatter
 * - Supports aliases for common topic names
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { ToolResult, WorkflowToolParams } from "./interfaces/tool-interface.js";
import { getUserContext } from "../core/request-context.js";
import {
  getSystemPrompt,
  logAuditEventDirect,
  AuditAction,
  createLogger,
  normalizeError,
  isOperationalError,
} from "@mcp-moira/shared";
import { renderPortableHelpTokens } from "@mcp-moira/shared/portable-help";
import { ERRORS, formatErrorWithAgentInstructions } from "../messages/index.js";
import { MCPEngine } from "../core/mcp-engine.js";
import type { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { renderClientSetupMarkdown } from "../help/client-presentation.js";

const logger = createLogger({ component: "GetHelp" });

interface HelpParams extends WorkflowToolParams {
  topic?: string | string[];
}

interface TopicSummary {
  title: string;
  description: string;
  category: string;
}

interface TopicInfo extends TopicSummary {
  file: string;
}

const HELP_CONTENT_DIR = fileURLToPath(new URL("../help/content/", import.meta.url));

// Topic aliases - map common names to canonical topic IDs
const TOPIC_ALIASES: Record<string, string> = {
  overview: "introduction", // overview -> introduction
  intro: "introduction",
  start: "quickstart",
  "getting-started": "introduction",
  node: "nodes",
  workflow: "workflows",
  template: "templates",
  tool: "tools",
  validate: "validation",
  pattern: "patterns",
  note: "notes",
};

// Category order and display names
const CATEGORY_ORDER: Record<string, string> = {
  "getting-started": "Getting Started",
  concepts: "Concepts",
  guides: "Guides",
  patterns: "Patterns",
  integration: "Integration",
  reference: "Reference",
};

const SPECIAL_TOPICS = {
  tools: {
    title: "MCP Tools Reference",
    description: "Complete reference for all MCP tools available in Moira",
    category: "reference",
  },
} as const satisfies Record<string, TopicSummary>;

// Cache for discovered topics (lazy initialization)
let topicCache: Map<string, TopicInfo> | null = null;

export async function getHelp(
  params: HelpParams = {},
  renderToolsReference?: () => string,
): Promise<ToolResult<string>> {
  try {
    // Get authenticated user context
    const { userId } = getUserContext();

    let { topic } = params;

    // Audit log for help request
    const repository = MCPEngine.getInstance().repository;
    await logAuditEventDirect(repository as DatabaseRepository, {
      userId,
      action: AuditAction.MCP_HELP_REQUEST,
      resource: "help",
      resourceId: Array.isArray(topic) ? topic.join(",") : topic || "index",
      source: "mcp",
      metadata: { topic: topic || null },
    });

    // No topic provided - return available topics
    if (!topic) {
      return {
        success: true,
        data: getTopicList(),
      };
    }

    // Handle JSON string array from MCP (e.g., '["topic1","topic2"]')
    if (typeof topic === "string" && topic.startsWith("[")) {
      try {
        const parsed = JSON.parse(topic);
        if (Array.isArray(parsed)) {
          topic = parsed;
        }
      } catch {
        // Not valid JSON, treat as regular string topic
      }
    }

    // Handle array of topics - concatenate content
    if (Array.isArray(topic)) {
      const contents: string[] = [];
      for (const t of topic) {
        const helpContent = await generateHelpContent(
          t,
          params.workflowsDirectory,
          renderToolsReference,
        );
        contents.push(`# Topic: ${t}\n\n${helpContent}`);
      }
      return { success: true, data: contents.join("\n\n---\n\n") };
    }

    // Provide help for specific topic
    const helpContent = await generateHelpContent(
      topic,
      params.workflowsDirectory,
      renderToolsReference,
    );

    return { success: true, data: helpContent };
  } catch (error) {
    // Normalize to AppError for consistent handling
    const appError = normalizeError(error);

    // LOG ONCE at boundary - use appropriate level based on error type
    // Operational errors (user errors) = WARN, Programmer errors = ERROR
    const logLevel = isOperationalError(appError) ? "warn" : "error";
    logger[logLevel]("Failed to get help", appError, {
      topic: params.topic,
      code: appError.code,
      isOperational: appError.isOperational,
    });

    // Add AGENT INSTRUCTIONS using auto-detection
    const enhancedError = formatErrorWithAgentInstructions(appError.message);
    return {
      success: false,
      error: enhancedError,
    };
  }
}

interface PortableHelpPaths {
  helpDirectory?: string;
  systemPrompt?: string;
}

function renderPortableMarkdown(content: string): string | null {
  try {
    return renderPortableHelpTokens(content).trim();
  } catch {
    return null;
  }
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "").trim();
}

function readSource(helpDirectory: string, relativePath: string): string | null {
  const sourcePath = path.join(helpDirectory, relativePath);
  return fs.existsSync(sourcePath) ? stripFrontmatter(fs.readFileSync(sourcePath, "utf8")) : null;
}

function composePortableHelpFile(
  relativePath: string,
  paths: PortableHelpPaths = {},
): string | null {
  const helpDirectory = paths.helpDirectory ?? HELP_CONTENT_DIR;
  const before = readSource(helpDirectory, relativePath);
  if (before === null) return null;
  const language = relativePath.startsWith("ru/") ? "ru" : "en";

  const insertsClientSetup = [
    "getting-started/quickstart.before.md",
    "integration/mcp-clients.before.md",
  ].some((suffix) => relativePath.endsWith(suffix));
  if (insertsClientSetup) {
    const after = readSource(helpDirectory, relativePath.replace(".before.md", ".after.md"));
    return after === null
      ? null
      : renderPortableMarkdown(
          `${before}\n\n${renderClientSetupMarkdown(language, "{MCP_URL}")}\n${after}`,
        );
  }
  if (relativePath.endsWith("integration/agent-instructions.before.md")) {
    const systemPrompt = stripFrontmatter(paths.systemPrompt ?? getSystemPrompt());
    return renderPortableMarkdown(`${before}\n\n${systemPrompt}`);
  }

  return renderPortableMarkdown(before);
}

/**
 * Extract frontmatter metadata from a semantic Markdown source.
 */
function extractFrontmatter(content: string): { title: string; description: string } {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return { title: "", description: "" };
  }

  const yaml = frontmatterMatch[1];

  // Extract title (simple regex, handles quoted and unquoted)
  const titleMatch = yaml.match(/^title:\s*["']?([^"'\n]+)["']?\s*$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";

  // Extract description (simple regex, handles quoted and unquoted)
  const descMatch = yaml.match(/^description:\s*["']?([^"'\n]+)["']?\s*$/m);
  const description = descMatch ? descMatch[1].trim() : "";

  return { title, description };
}

/**
 * Convert file path to topic ID
 * Examples:
 * - "getting-started/introduction.mdx" -> "introduction"
 * - "patterns/skip.mdx" -> "pattern-skip"
 * - "patterns/index.mdx" -> "patterns"
 * - "reference/workflows/robust-task.mdx" -> "workflow-robust-task"
 */
function filePathToTopicId(relativePath: string): string {
  const parts = relativePath.replace(/(?:\.before)?\.(?:mdx|md)$/, "").split("/");
  const category = parts[0];
  const fileName = parts[parts.length - 1];

  // index.mdx -> use directory name as topic
  if (fileName === "index") {
    return category;
  }

  // patterns/*.mdx -> pattern-{name}
  if (category === "patterns") {
    return `pattern-${fileName}`;
  }

  // reference/workflows/*.mdx -> workflow-{name}
  if (category === "reference" && parts[1] === "workflows") {
    return `workflow-${fileName}`;
  }

  // Default: just use filename
  return fileName;
}

/**
 * Get category from file path
 */
function getCategoryFromPath(relativePath: string): string {
  const parts = relativePath.split("/");
  return parts[0];
}

/**
 * Recursively scan the MCP-owned portable help corpus.
 * Excludes translations, insertion suffixes, and website-only workflow references.
 */
function scanHelpFiles(dir: string, baseDir: string, files: string[] = []): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const relativeDirPath = path.relative(baseDir, dir);

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip ru/ translations
        if (entry.name === "ru") continue;
        // Skip reference/workflows/ (website-only, too many individual workflow docs)
        if (relativeDirPath === "reference" && entry.name === "workflows") continue;
        scanHelpFiles(fullPath, baseDir, files);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        !entry.name.endsWith(".after.md")
      ) {
        const relativePath = path.relative(baseDir, fullPath);
        files.push(relativePath);
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }

  return files;
}

/**
 * Discover all runtime topics from the MCP-owned semantic corpus.
 */
function discoverTopics(helpDirectory = HELP_CONTENT_DIR): Map<string, TopicInfo> {
  if (helpDirectory === HELP_CONTENT_DIR && topicCache) {
    return topicCache;
  }

  const topics = new Map<string, TopicInfo>();

  if (!fs.existsSync(helpDirectory)) {
    if (helpDirectory === HELP_CONTENT_DIR) topicCache = topics;
    return topics;
  }

  const helpFiles = scanHelpFiles(helpDirectory, helpDirectory);

  for (const file of helpFiles) {
    const topicId = filePathToTopicId(file);
    const category = getCategoryFromPath(file);

    // Read frontmatter for metadata
    const fullPath = path.join(helpDirectory, file);
    const content = fs.readFileSync(fullPath, "utf-8");
    const { title, description } = extractFrontmatter(content);

    topics.set(topicId, {
      file,
      title: title || topicId,
      description,
      category,
    });
  }

  if (helpDirectory === HELP_CONTENT_DIR) topicCache = topics;
  return topics;
}

/**
 * Resolve topic ID (handles aliases)
 */
function resolveTopicId(topic: string): string {
  return TOPIC_ALIASES[topic] || topic;
}

/**
 * Get topic info by ID (resolves aliases)
 */
function getTopicInfo(topic: string, helpDirectory = HELP_CONTENT_DIR): TopicInfo | undefined {
  const topics = discoverTopics(helpDirectory);
  const resolvedId = resolveTopicId(topic);
  return topics.get(resolvedId);
}

function getTopicCatalog(helpDirectory = HELP_CONTENT_DIR): Map<string, TopicSummary> {
  const topics = new Map<string, TopicSummary>(discoverTopics(helpDirectory));
  for (const [topicId, info] of Object.entries(SPECIAL_TOPICS)) {
    topics.set(topicId, info);
  }
  return topics;
}

function getTopicList(helpDirectory = HELP_CONTENT_DIR): string {
  const topics = getTopicCatalog(helpDirectory);

  // Group topics by category
  const byCategory = new Map<string, string[]>();

  for (const [topicId, info] of topics) {
    const displayCategory = CATEGORY_ORDER[info.category] || info.category;
    if (!byCategory.has(displayCategory)) {
      byCategory.set(displayCategory, []);
    }
    byCategory.get(displayCategory)!.push(topicId);
  }

  let result = "# Available Help Topics\n\n";

  // Quick reference by use case
  result += "## Quick Reference\n\n";
  result += "**New to Moira?** Start with: `introduction`, `quickstart`\n";
  result += "**Creating workflow?** See: `workflow-creation`, `nodes`, `templates`\n";
  result += "**Pattern examples?** See: `patterns`, `pattern-skip`, `pattern-branching`\n";
  result += "**Agent integration?** See: `agent-guide`, `troubleshooting`\n";
  result += "**Validation issues?** See: `validation`, `input-schema`\n\n";

  // Output in defined category order with counts
  for (const [_categoryKey, displayName] of Object.entries(CATEGORY_ORDER)) {
    const topicIds = byCategory.get(displayName);
    if (!topicIds || topicIds.length === 0) continue;

    // Sort topics within category
    topicIds.sort((a, b) => {
      // patterns/index should come first
      if (a === "patterns") return -1;
      if (b === "patterns") return 1;
      return a.localeCompare(b);
    });

    result += `**${displayName} (${topicIds.length}):**\n`;
    for (const topicId of topicIds) {
      const info = topics.get(topicId);
      if (info?.description) {
        result += `- \`${topicId}\` - ${info.description}\n`;
      } else {
        result += `- \`${topicId}\`\n`;
      }
    }
    result += "\n";
  }

  result += `## Usage\n\n`;
  result += `- Single topic: \`help({ topic: "introduction" })\`\n`;
  result += `- Multiple topics: \`help({ topic: ["pattern-skip", "pattern-branching"] })\`\n\n`;

  result += `**Aliases:** overview, intro, start, node, workflow, template, tool, validate, pattern\n\n`;

  // Workflow mapping for non-Claude agents
  result += `## Task → Workflow Mapping\n\n`;
  result += `Use these examples only after discovering the complete authorized catalog with \`list()\`; compare every returned workflow's deliverable, evidence, cost, durability, authority, failure outcomes, and neighboring alternatives before starting one.\n\n`;
  result += `| User Request Contains | Start Workflow |\n`;
  result += `| --------------------- | -------------- |\n`;
  result += `| "develop feature", "implement", "build feature", "fix bug" | \`moira/software-development-flow\` |\n`;
  result += `| one bounded low-risk software outcome with contained recovery; hand off when security, data, public contracts, rollout, uncertainty, or multiple units spread | \`moira/software-development-flow-lite\` |\n`;
  result += `| general plan-first task where only the current plan/evidence must remain durable | \`moira/simple-plan-execution\` |\n`;
  result += `| one bounded task needing decomposition, independent item review, changed retries, suffix revision, and filesystem or memory operation | \`moira/task-breakdown-flow\` |\n`;
  result += `| human-guided stream of tasks that are not known in advance | \`moira/infinite-task-loop\` |\n`;
  result += `| a known checklist needing a durable cursor, minimal orchestration, optional mid-run revision, and no independent final review or aggregate result model | \`moira/todo-list\` |\n`;
  result += `| bounded non-development filesystem task (1-10 work units) **Recommended** | \`moira/quick-task\` |\n`;
  result += `| complex critical task needing durable recovery, cause-aware independent review, bounded result/evidence repair, replanning, and truthful incomplete delivery | \`moira/robust-task\` |\n`;
  result += `| "create workflow", "make workflow", "new workflow" | \`moira/workflow-management-flow\` |\n`;
  result += `| first-time orientation that discovers and compares every currently authorized public workflow before an explicit child start | \`moira/user-onboarding\` |\n`;
  result += `| design or revise a software architecture with explicit constraints, alternatives, decisions, risks, and independent review | \`moira/architecture-design-flow\` |\n`;
  result += `| implement executable tests for one authorized existing-project target without changing production code | \`moira/test-generation\` |\n`;
  result += `| "test plan", "QA strategy" | \`moira/test-planning\` |\n`;
  result += `| "audit tests", "test suite audit", "find test gaps or redundancy" | \`moira/test-suite-audit\` |\n`;
  result += `| one reviewed article, post, documentation, email or other bounded text with durable evidence and optional target-bound delivery | \`moira/content-creation\` |\n`;
  result += `| one bounded external-source question needing durable evidence, independent semantic review, and truthful complete or limited local delivery | \`moira/verified-research\` |\n`;
  result += `| separately authorized expensive research that must read and synthesize a defined corpus as a whole | \`moira/deep-corpus-research\` |\n`;
  result += `| external research needing durable source evidence, repeated independent zero-issue review, and changed repair | \`moira/iterative-research\` |\n`;
  result += `| portable adaptive research needing filesystem-or-memory operation, pre-access authority review, evidence readiness, exact-zero final review, and separately authorized delivery | \`moira/universal-research-workflow\` |\n`;
  result += `| "create PRD", "requirements document" | \`moira/prd-creation\` |\n`;
  result += `| "validate startup idea", "assess startup hypothesis", "should we build this startup" | \`moira/startup-idea-validation\` |\n`;
  result += `| evidence-linked product selection with current prices/terms, profile-specific recommendations, buyer guidance, reviewed self-contained HTML, and optional delivery; start with \`skipTelegramCheck: true\` | \`moira/smart-purchase-assistant\` |\n`;
  result += `| "design UI", "wireframe", "mockup" | \`moira/ux-design\` |\n`;
  result += `| "analyze data", "data analysis" | \`moira/data-analysis\` |\n`;
  result += `| evidence-aware campaign strategy plus channel materials, proof mapping, independent review, and truthful local delivery | \`moira/marketing-campaign\` |\n`;
  result += `| analyze one completed execution using authorized session, workflow, artifact, review, retry, and correction evidence; propose improvements without applying them | \`moira/execution-retrospective\` |\n`;
  result += `| configure and verify the current user's Moira Telegram notifications without exposing the bot token or full chat ID | \`moira/telegram-setup\` |\n`;
  result += `| create a reviewed visual presentation of a workflow's purpose, graph, routes, variables, and operating contract | \`moira/workflow-presentation-generator\` |\n\n`;
  result += `Start: \`mcp__moira__start({ workflowId: "moira/quick-task", parentExecutionId: "none" })\``;

  return result;
}

async function generateHelpContent(
  topic: string,
  _workflowsDir?: string,
  renderToolsReference?: () => string,
  paths: PortableHelpPaths = {},
): Promise<string> {
  if (resolveTopicId(topic) === "tools" && renderToolsReference) {
    return renderToolsReference();
  }

  // Resolve alias and get topic info
  const helpDirectory = paths.helpDirectory ?? HELP_CONTENT_DIR;
  const topicInfo = getTopicInfo(topic, helpDirectory);
  if (topicInfo) {
    const content = composePortableHelpFile(topicInfo.file, paths);
    if (content) {
      return content;
    }
    return `${ERRORS.documentation_file_not_found(topicInfo.file, helpDirectory)}\n\n${getTopicList(helpDirectory)}`;
  }

  return `${ERRORS.unknown_help_topic(topic)}\n\nHint: Use help() without arguments to see all available topics.`;
}

// Export for testing
export const _testing = {
  renderPortableMarkdown,
  stripFrontmatter,
  composePortableHelpFile,
  extractFrontmatter,
  filePathToTopicId,
  resolveTopicId,
  discoverTopics,
  scanHelpFiles,
  getTopicList,
  generateHelpContent,
  resetCache: () => {
    topicCache = null;
  },
};
