/**
 * Better Auth instance for Web Backend
 * Created with service-specific error logging
 */

import { createAuth, createLogger } from "@mcp-moira/shared";
import { notifyAdminsOfRegistration } from "@mcp-moira/workflow-engine";

const logger = createLogger({ component: "BetterAuth" });
export const auth = createAuth(logger, { onSuccessfulRegistration: notifyAdminsOfRegistration });
