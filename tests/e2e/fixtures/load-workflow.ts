/**
 * Utility to load workflow fixture onto server
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { Page } from "@playwright/test";
import { getTestBaseUrl } from "../../utils/test-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get base URL for API requests
const BASE_URL = getTestBaseUrl();

/**
 * Load workflow fixture into server using authenticated page context
 *
 * @param page - Playwright page with authenticated context
 * @param workflowFileName - Name of workflow file in fixtures/workflows/
 * @param visibility - Workflow visibility
 * @param _overrideId - DEPRECATED: Server now generates UUIDs, this parameter is ignored
 * @returns Object with success status, actual workflowId (UUID from server), and slug
 */
export async function loadWorkflowFixture(
  page: Page,
  workflowFileName: string,
  visibility: "public" | "private" = "private",
  _overrideId?: string,
): Promise<{ success: boolean; workflowId: string; slug: string; workflowName: string }> {
  // Read workflow file
  const workflowPath = join(__dirname, "workflows", workflowFileName);
  const workflowContent = readFileSync(workflowPath, "utf-8");
  const workflow = JSON.parse(workflowContent);

  console.log(`✓ Workflow file loaded: ${workflow.metadata.name}`);

  // Upload workflow using page.request API with explicit base URL
  // Server generates UUID and slug automatically
  try {
    const response = await page.request.post(`${BASE_URL}/api/workflows`, {
      data: {
        workflow: {
          metadata: workflow.metadata,
          nodes: workflow.nodes,
        },
        visibility,
      },
    });

    if (!response.ok()) {
      const error = await response.text();
      console.error(
        `Failed to load workflow ${workflow.metadata.name}: ${response.status()} ${error}`,
      );
      return {
        success: false,
        workflowId: "",
        slug: "",
        workflowName: workflow.metadata.name,
      };
    }

    // Parse response to get actual server-generated workflowId and slug
    const responseData = await response.json();
    const actualWorkflowId = responseData.data?.workflowId || responseData.workflowId || "";
    const actualSlug = responseData.data?.slug || responseData.slug || "";

    console.log(
      `✓ Workflow loaded: ${workflow.metadata.name} (id: ${actualWorkflowId}, slug: ${actualSlug})`,
    );
    return {
      success: true,
      workflowId: actualWorkflowId,
      slug: actualSlug,
      workflowName: workflow.metadata.name,
    };
  } catch (error) {
    console.error(`Exception loading workflow: ${error}`);
    return {
      success: false,
      workflowId: "",
      slug: "",
      workflowName: workflow.metadata.name,
    };
  }
}
