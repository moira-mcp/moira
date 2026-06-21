/**
 * Test script to verify workflow loading works
 * Usage: tsx tests/e2e/fixtures/test-load-workflow.ts
 */

import { loadWorkflowFixture } from "./load-workflow.js";
import { getTestBaseUrl } from "../../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

async function main() {
  console.log("Testing workflow loading...");
  console.log(`Base URL: ${BASE_URL}`);

  const success = await loadWorkflowFixture({
    baseUrl: BASE_URL,
    workflowFileName: "react-flow-theme-test.json",
  });

  if (success) {
    console.log("✅ Workflow loaded successfully");
    process.exit(0);
  } else {
    console.error("❌ Failed to load workflow");
    process.exit(1);
  }
}

main();
