/**
 * MCP Tool: Get Help
 * Provides on-demand documentation for workflows, tools, and system concepts
 * Reads documentation exclusively from MDX files - single source of truth
 *
 * Topics are discovered dynamically from filesystem:
 * - Scans DOCS_DIR for MDX files (excluding ru/ translations)
 * - Generates topic IDs from file paths
 * - Extracts metadata (title, description) from frontmatter
 * - Supports aliases for common topic names
 */

import * as fs from "fs";
import * as path from "path";
import { ToolResult, WorkflowToolParams } from "./interfaces/tool-interface.js";
import { getUserContext } from "../core/request-context.js";
import {
  getDocsDir,
  logAuditEventDirect,
  AuditAction,
  createLogger,
  normalizeError,
  isOperationalError,
} from "@mcp-moira/shared";
import { ERRORS, formatErrorWithAgentInstructions } from "../messages/index.js";
import { MCPEngine } from "../core/mcp-engine.js";
import type { DatabaseRepository } from "@mcp-moira/workflow-engine";

const logger = createLogger({ component: "GetHelp" });

interface HelpParams extends WorkflowToolParams {
  topic?: string | string[];
}

interface TopicInfo {
  file: string; // Relative path from DOCS_DIR
  title: string;
  description: string;
  category: string;
}

// MDX docs directory - copied from packages/docs at Docker build time
const DOCS_DIR = getDocsDir();

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

// Cache for discovered topics (lazy initialization)
let topicCache: Map<string, TopicInfo> | null = null;

export async function getHelp(params: HelpParams = {}): Promise<ToolResult<string>> {
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
        const helpContent = await generateHelpContent(t, params.workflowsDirectory);
        contents.push(`# Topic: ${t}\n\n${helpContent}`);
      }
      return { success: true, data: contents.join("\n\n---\n\n") };
    }

    // Provide help for specific topic
    const helpContent = await generateHelpContent(topic, params.workflowsDirectory);

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

/**
 * Strip MDX frontmatter (YAML between --- delimiters)
 */
function stripFrontmatter(content: string): string {
  const frontmatterRegex = /^---\s*\n[\s\S]*?\n---\s*\n/;
  return content.replace(frontmatterRegex, "");
}

/**
 * Strip MDX/JSX imports and components
 */
function stripJsx(content: string): string {
  // Remove import statements
  let result = content.replace(/^import\s+.*?;\s*$/gm, "");

  // Remove self-closing JSX tags like <Component />
  result = result.replace(/<[A-Z][a-zA-Z]*\s*[^>]*\/>/g, "");

  // Remove JSX component blocks like <Card>...</Card>, <CardGrid>...</CardGrid>
  // Handle nested components by iterating until no more matches
  let prevResult = "";
  while (prevResult !== result) {
    prevResult = result;
    result = result.replace(/<([A-Z][a-zA-Z]*)[^>]*>[\s\S]*?<\/\1>/g, (match) => {
      // Extract text content from inside the component for readability
      const innerText = match
        .replace(/<[^>]+>/g, "") // Remove all tags
        .trim();
      return innerText ? innerText : "";
    });
  }

  // Clean up multiple blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * Read and process MDX file
 */
function readMdxFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    const withoutFrontmatter = stripFrontmatter(content);
    const withoutJsx = stripJsx(withoutFrontmatter);
    return withoutJsx;
  } catch {
    return null;
  }
}

/**
 * Extract frontmatter metadata from MDX content
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
  const parts = relativePath.replace(/\.mdx$/, "").split("/");
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
 * Recursively scan directory for MDX files
 * Excludes: ru/ translations, reference/workflows/ (website-only workflow catalog)
 */
function scanMdxFiles(dir: string, baseDir: string, files: string[] = []): string[] {
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
        scanMdxFiles(fullPath, baseDir, files);
      } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
        // Get relative path from base docs dir
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
 * Discover all topics from MDX files in DOCS_DIR
 */
function discoverTopics(): Map<string, TopicInfo> {
  if (topicCache) {
    return topicCache;
  }

  const topics = new Map<string, TopicInfo>();

  // Skip if DOCS_DIR doesn't exist (e.g., in tests without real filesystem)
  if (!fs.existsSync(DOCS_DIR)) {
    topicCache = topics;
    return topics;
  }

  const mdxFiles = scanMdxFiles(DOCS_DIR, DOCS_DIR);

  for (const file of mdxFiles) {
    // Skip docs/index.mdx (root index)
    if (file === "index.mdx") continue;

    const topicId = filePathToTopicId(file);
    const category = getCategoryFromPath(file);

    // Read frontmatter for metadata
    const fullPath = path.join(DOCS_DIR, file);
    const content = fs.readFileSync(fullPath, "utf-8");
    const { title, description } = extractFrontmatter(content);

    topics.set(topicId, {
      file,
      title: title || topicId,
      description,
      category,
    });
  }

  topicCache = topics;
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
function getTopicInfo(topic: string): TopicInfo | undefined {
  const topics = discoverTopics();
  const resolvedId = resolveTopicId(topic);
  return topics.get(resolvedId);
}

function getTopicList(): string {
  const topics = discoverTopics();

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
  result += `Use this when user requests match these patterns:\n\n`;
  result += `| User Request Contains | Start Workflow |\n`;
  result += `| --------------------- | -------------- |\n`;
  result += `| "develop feature", "implement", "build feature", "fix bug" | \`moira/software-development-flow\` |\n`;
  result += `| "small feature", "quick fix", "simple task with tests" | \`moira/software-development-flow-lite\` |\n`;
  result += `| any multi-step task (2-10 steps) **Recommended** | \`moira/quick-task\` |\n`;
  result += `| complex critical task | \`moira/robust-task\` |\n`;
  result += `| "create workflow", "make workflow", "new workflow" | \`moira/workflow-management-flow\` |\n`;
  result += `| "write tests", "create tests", "add tests" | \`moira/test-generation\` |\n`;
  result += `| "test plan", "QA strategy" | \`moira/test-planning\` |\n`;
  result += `| "write article", "create post", "write docs" | \`moira/content-creation\` |\n`;
  result += `| "research", "investigate", "look up" | \`moira/verified-research\` |\n`;
  result += `| "create PRD", "requirements document" | \`moira/prd-creation\` |\n`;
  result += `| "design UI", "wireframe", "mockup" | \`moira/ux-design\` |\n`;
  result += `| "analyze data", "data analysis" | \`moira/data-analysis\` |\n`;
  result += `| "marketing campaign", "promotional content" | \`moira/marketing-campaign\` |\n\n`;
  result += `Start: \`mcp__moira__start({ workflowId: "moira/quick-task", parentExecutionId: "none" })\``;

  return result;
}

async function generateHelpContent(topic: string, _workflowsDir?: string): Promise<string> {
  // Resolve alias and get topic info
  const topicInfo = getTopicInfo(topic);
  if (topicInfo) {
    const filePath = path.join(DOCS_DIR, topicInfo.file);
    const content = readMdxFile(filePath);
    if (content) {
      return content;
    }
    // MDX file not found - return error message
    return `${ERRORS.documentation_file_not_found(topicInfo.file, DOCS_DIR)}\n\n${getTopicList()}`;
  }

  return `${ERRORS.unknown_help_topic(topic)}\n\nHint: Use help() without arguments to see all available topics.`;
}

// Export for testing
export const _testing = {
  extractFrontmatter,
  filePathToTopicId,
  resolveTopicId,
  discoverTopics,
  getTopicList,
  resetCache: () => {
    topicCache = null;
  },
};
