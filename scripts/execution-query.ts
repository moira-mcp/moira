#!/usr/bin/env tsx

/**
 * Execution Query Tool
 *
 * Query execution context variables from database.
 *
 * Usage:
 *   npm run execution <execution-id> variables [var1,var2,var3]
 *
 * Examples:
 *   npm run execution abc123 variables                    # All variables
 *   npm run execution abc123 variables task_name,status   # Specific variables
 */

// Load environment variables from .env.local BEFORE any shared imports
// This must happen before ESM module loading of @mcp-moira/shared
import "dotenv/config";
// Note: dotenv/config auto-loads from .env, but we need .env.local
import { config } from "dotenv";
config({ path: ".env.local", override: true });

import { getDatabase } from "@mcp-moira/shared";

// === COLORS ===
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

type ColorName = keyof typeof colors;

function c(color: ColorName, text: string | number): string {
  return `${colors[color]}${text}${colors.reset}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
${c("bright", "Execution Query Tool")}

${c("cyan", "Usage:")}
  npm run execution <execution-id> variables [var1,var2,var3]

${c("cyan", "Commands:")}
  variables [vars]    Query execution context variables
                      Optionally filter by comma-separated variable names

${c("cyan", "Examples:")}
  npm run execution abc123 variables                    # All variables
  npm run execution abc123 variables task_name,status   # Specific variables
`);
    process.exit(0);
  }

  const executionId = args[0];
  const command = args[1];

  if (command !== "variables") {
    console.error(c("red", `ERROR: Unknown command: ${command}`));
    console.log("Run with --help to see available commands");
    process.exit(1);
  }

  // Parse variable filter
  const filterVars = args[2] ? args[2].split(",").map((v) => v.trim()) : null;

  try {
    const db = getDatabase();

    // Query execution from database
    const execution = await db.query.execution.findFirst({
      where: (exec, { eq }) => eq(exec.executionId, executionId),
      columns: {
        executionId: true,
        workflowId: true,
        status: true,
        globalContext: true,
        currentNodeId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!execution) {
      console.error(c("red", `ERROR: Execution not found: ${executionId}`));
      process.exit(1);
    }

    console.log("");
    console.log(c("bright", "═".repeat(80)));
    console.log(c("bright", `  Execution: ${execution.executionId}`));
    console.log(c("bright", "═".repeat(80)));
    console.log("");

    console.log(c("cyan", "Metadata:"));
    console.log(`  Workflow ID: ${c("yellow", execution.workflowId)}`);
    console.log(`  Status: ${c("green", execution.status)}`);
    console.log(`  Current Node: ${execution.currentNodeId || "(none)"}`);
    console.log(`  Created: ${new Date(execution.createdAt).toISOString()}`);
    console.log(`  Updated: ${new Date(execution.updatedAt).toISOString()}`);
    console.log("");

    // Parse global context
    const context =
      typeof execution.globalContext === "string"
        ? JSON.parse(execution.globalContext)
        : execution.globalContext;

    const variables = context?.variables || {};

    console.log(c("cyan", "Variables:"));
    console.log(c("dim", "─".repeat(80)));

    if (Object.keys(variables).length === 0) {
      console.log(c("yellow", "  No variables in context"));
    } else {
      // Filter variables if specified
      const varsToShow = filterVars
        ? Object.entries(variables).filter(([name]) => filterVars.includes(name))
        : Object.entries(variables);

      if (filterVars && varsToShow.length === 0) {
        console.log(c("yellow", `  No matching variables found for: ${filterVars.join(", ")}`));
      } else {
        varsToShow.forEach(([name, value]) => {
          console.log(c("green", `  ${name}:`));

          // Format value nicely
          if (value === null || value === undefined) {
            console.log(`    ${c("gray", "(null)")}`);
          } else if (typeof value === "string") {
            const preview = value.length > 200 ? value.substring(0, 200) + "..." : value;
            const lines = preview.split("\n");
            lines.slice(0, 5).forEach((line) => {
              console.log(`    ${line}`);
            });
            if (lines.length > 5) {
              console.log(`    ${c("gray", `... (${lines.length - 5} more lines)`)}`);
            }
          } else if (typeof value === "object") {
            const jsonStr = JSON.stringify(value, null, 2);
            const lines = jsonStr.split("\n");
            lines.slice(0, 10).forEach((line) => {
              console.log(`    ${line}`);
            });
            if (lines.length > 10) {
              console.log(`    ${c("gray", `... (${lines.length - 10} more lines)`)}`);
            }
          } else {
            console.log(`    ${value}`);
          }
          console.log("");
        });
      }
    }

    console.log(
      c("cyan", `Total: ${c("bright", Object.keys(variables).length)} variable(s) in context`),
    );
    console.log("");
  } catch (error) {
    console.error(c("red", `ERROR: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

main();
