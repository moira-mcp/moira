#!/usr/bin/env tsx
/**
 * Simple script to upload workflow fixture to server
 * Usage: tsx tests/e2e/fixtures/upload-workflow.ts react-flow-theme-test.json
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getTestBaseUrl, getTestFetchUrl, getAdminCredentials } from "../../utils/test-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();
const { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } = getAdminCredentials();

async function login(): Promise<string> {
  const response = await fetch(`${FETCH_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    }),
  });

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status} ${await response.text()}`);
  }

  // Extract session cookie
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("No session cookie received");
  }

  const sessionCookie = setCookie.split(";")[0];
  console.log("✓ Logged in successfully");
  console.log("Session cookie:", sessionCookie);
  return sessionCookie;
}

async function uploadWorkflow(workflowFileName: string, sessionCookie: string): Promise<void> {
  // Read workflow file
  const workflowPath = join(__dirname, "workflows", workflowFileName);
  const workflowContent = readFileSync(workflowPath, "utf-8");
  const workflow = JSON.parse(workflowContent);

  const url = `${FETCH_URL}/api/workflows`;
  console.log(`Posting to URL: ${url}`);
  console.log(`Using cookie: ${sessionCookie}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      id: workflow.id,
      workflow: {
        metadata: workflow.metadata,
        nodes: workflow.nodes,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upload failed: ${response.status} ${error}`);
  }

  const result = await response.json();
  console.log(`✓ Workflow uploaded: ${workflow.metadata.name}`);
  console.log(`  ID: ${workflow.id}`);
  console.log(`  Validation: ${result.data?.validation?.valid ? "VALID" : "INVALID"}`);
}

async function main() {
  const workflowFile = process.argv[2];

  if (!workflowFile) {
    console.error("Usage: tsx upload-workflow.ts <workflow-file.json>");
    process.exit(1);
  }

  try {
    const sessionCookie = await login();
    await uploadWorkflow(workflowFile, sessionCookie);
    console.log("\n✅ SUCCESS");
  } catch (error) {
    console.error("\n❌ FAILED:", error);
    process.exit(1);
  }
}

main();
