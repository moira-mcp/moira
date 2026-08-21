/**
 * Extended Express types for web-backend
 */

import { Request } from "express";

/**
 * Extended Request with authenticated user data from better-auth middleware
 * This is used for routes that only work with authenticated requests
 */
export interface AuthenticatedRequest extends Request {
  userId: string;
  userEmail: string;
  emailVerified?: boolean;
  approvedAt?: string | null;
  accountApproved?: boolean;
  accountApprovalRequired?: boolean;
  userInfo?: {
    isAdmin: boolean;
    handle: string;
    passwordResetRequired: boolean;
    blocked: boolean;
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
