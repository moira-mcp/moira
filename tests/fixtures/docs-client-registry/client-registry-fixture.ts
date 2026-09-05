import { mcpClients, type McpClient } from "../../../packages/shared/src/mcp-clients/index.js";

const cursor = mcpClients.find((client) => client.id === "cursor");
if (!cursor) throw new Error("Cursor client fixture source is missing");

export const addedRegistryClient: McpClient = {
  ...cursor,
  id: "fixture-client",
  name: "Fixture Client",
  setup: {
    ...cursor.setup,
    alternative: {
      ...cursor.setup.alternative!,
      title: "Fixture Registry Addition",
    },
  },
};

export const registryWithAddedClient: readonly McpClient[] = [...mcpClients, addedRegistryClient];
