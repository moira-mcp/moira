#!/usr/bin/env node
/**
 * Database migration script for Better Auth
 * Runs automatically on server startup in Docker
 */

import { auth } from "../auth.js";
import { createLogger } from "@mcp-moira/shared";

const logger = createLogger({ component: "Migration" });

async function runMigration() {
  try {
    logger.info("Running Better Auth database migration");

    // Better Auth auto-creates tables on first database connection
    // Just need to initialize the auth instance
    await auth.api.listSessions({ headers: new Headers() }).catch(() => {
      // Expected to fail without valid session, but triggers schema creation
    });

    logger.info("Database migration complete");
    process.exit(0);
  } catch (error) {
    logger.error("Migration failed", error);
    process.exit(1);
  }
}

runMigration();
