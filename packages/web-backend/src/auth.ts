/**
 * Better Auth instance for Web Backend
 * Created with service-specific error logging
 */

import { createAuth, createLogger } from "@mcp-moira/shared";

const logger = createLogger({ component: "BetterAuth" });
export const auth = createAuth(logger);
