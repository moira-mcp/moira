/**
 * Admin Role Utilities
 * Shared admin role checking logic
 */

import { getDatabase, user } from "@mcp-moira/shared";
import { eq } from "drizzle-orm";

export async function checkAdminRole(userId: string): Promise<boolean> {
  // Check admin flag in database
  const db = getDatabase();

  const [userRecord] = await db.select().from(user).where(eq(user.id, userId)).limit(1);

  return userRecord?.isAdmin === true;
}
