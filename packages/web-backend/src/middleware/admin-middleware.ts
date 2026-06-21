/**
 * Admin middleware for Web Backend API routes
 * Checks if user has admin role
 *
 * Uses unified error architecture - throws AppError classes
 * which are caught and logged at the HTTP boundary (error-middleware.ts)
 */

import { Request, Response, NextFunction } from "express";
import { checkAdminRole } from "../utils/admin-utils.js";
import { AuthenticatedRequest } from "../types/express-types.js";
import { AuthenticationError, AuthorizationError, InternalError } from "@mcp-moira/shared";

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as AuthenticatedRequest).userId; // From requireAuth middleware

    if (!userId) {
      throw new AuthenticationError("Authentication required");
    }

    // Check admin role
    const isAdmin = await checkAdminRole(userId);

    if (!isAdmin) {
      throw new AuthorizationError("Admin permission required");
    }

    next();
  } catch (error) {
    // If already an AppError, let it bubble up to error-middleware
    if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
      next(error);
      return;
    }
    // Wrap unexpected errors
    next(new InternalError("Admin check failed", { cause: error as Error }));
  }
}
