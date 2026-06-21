/**
 * Extended Express types for web-backend
 */

import { Request } from "express";

/**
 * Better Auth user object added to request
 */
export interface BetterAuthUser {
  userId: string;
  email: string;
  name?: string;
  image?: string | null;
  emailVerified: boolean;
  isAdmin?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Extended Request with authenticated user data from better-auth middleware
 * This is used for routes that only work with authenticated requests
 */
export interface AuthenticatedRequest extends Request {
  user?: BetterAuthUser;
  userId: string;
  userEmail: string;
  emailVerified?: boolean;
  userInfo?: {
    isAdmin: boolean;
  };
  session?: {
    token: string;
  };
}

/**
 * Type guard to check if request has auth properties
 */
export function isAuthenticatedRequest(req: Request): req is AuthenticatedRequest {
  return "userId" in req && "userEmail" in req;
}
