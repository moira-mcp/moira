#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Simplified CLI runner for Moira workflows
 * Console output is intentional for user-facing terminal interface
 */

import { MCPEngine } from "./core/mcp-engine.js";
import readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

async function runWorkflow(workflowId: string) {
  console.log("🚀 Simplified Moira Workflow Runner\n");

  try {
    // Use singleton MCPEngine to start workflow by ID
    let responseText = await MCPEngine.getInstance().startWorkflow(workflowId);

    // Parse processId from the response text
    const processIdMatch = responseText.match(/Process ID:\s*([a-f0-9-]+)/i);
    if (!processIdMatch) {
      throw new Error("Failed to extract process ID from workflow start response");
    }
    const processId = processIdMatch[1];

    console.log(`✅ Workflow started with ID: ${processId}\n`);
    console.log(responseText);

    // Continue execution steps until completion

    while (true) {
      try {
        // Check if response requires input by looking for specific patterns
        const requiresInput =
          responseText.includes("inputSchema") ||
          responseText.includes("Input required") ||
          responseText.includes("Expected input format");

        if (!requiresInput) {
          console.log("\n🎉 Workflow completed successfully!");
          break;
        }

        const userInput = await prompt('\n   Enter JSON input (or "skip" to continue): ');

        let input: unknown = undefined;
        if (userInput.toLowerCase() !== "skip") {
          try {
            input = JSON.parse(userInput);
          } catch (e) {
            console.log("   ⚠️  Invalid JSON, treating as text input");
            input = { input: userInput };
          }
        }

        // Execute step
        responseText = await MCPEngine.getInstance().executeStep(processId, input);
        console.log("\n", responseText);
      } catch (stepError) {
        if (stepError instanceof Error && stepError.message.includes("completed")) {
          console.log("\n🎉 Workflow completed successfully!");
          break;
        }
        throw stepError;
      }
    }
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    rl.close();
  }
}

// CLI entry point
if (process.argv.length < 3) {
  console.log("Usage: npm run cli <workflow-id>");
  console.log("Example: npm run cli user-interaction");
  process.exit(1);
}

const workflowId = process.argv[2];
runWorkflow(workflowId);
