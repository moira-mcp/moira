/**
 * Better Auth React client for MCP Moira frontend
 */

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: "", // Same domain - better-auth auto-detects
});

// Export hooks for components
export const { useSession, signIn, signUp, signOut } = authClient;

export type Session = typeof authClient.$Infer.Session;
