/**
 * Better Auth configuration for MCP Moira
 */

import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { createAuthMiddleware, APIError, getSessionFromCtx } from "better-auth/api";
import { mcp } from "better-auth/plugins";
import { timingSafeEqual } from "crypto";
import geoip from "geoip-lite";
import type { ServiceLogger } from "../logging/logger.js";
import { createLogger } from "../logging/logger.js";
import { getSqliteInstance, getDatabase } from "../database/connection.js";
import { sendEmail, isEmailConfigured } from "../email/index.js";
import { AuditRepository } from "../database/repositories/audit-repository.js";
import { AuditAction } from "../audit/actions.js";
import { user, oauthAccessToken } from "../database/schema.js";
import { eq } from "drizzle-orm";
import { getBaseUrl, getAuthUrl, getMcpUrl, isProduction } from "../config/urls.js";
import {
  getBetterAuthSecret,
  getGitHubClientId,
  getGitHubClientSecret,
  getGoogleClientId,
  getGoogleClientSecret,
  getLoadTestSecret,
  isLoadTestAuthEnabled,
  getExtraTrustedOrigins,
} from "../config/env.js";
import { getMcpServerVersion } from "../config/mcp-version.js";
import { getFeatureResolver } from "../services/index.js";
import { ACCOUNT_APPROVAL_REQUIRED_CODE, getAccountAccessDenial } from "./account-admission.js";
import { generateHandleFromEmail, generateRandomHandleSuffix } from "../validation/slug-handle.js";

const logger = createLogger({ component: "BetterAuth" });

// Load testing domain - users with this domain can bypass email verification
// when X-Load-Test header matches LOAD_TEST_SECRET
const LOAD_TEST_DOMAIN = "load-testing-noverify.local";

// These configured Better Auth endpoints establish identity or are authorized
// by a one-time token, not by an existing browser session. An incidental pending
// cookie must not turn signup, login, email verification, or password recovery
// into an approval-gated capability. All unlisted paths remain denied by default.
const PUBLIC_ACCOUNT_LIFECYCLE_PATHS = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/sign-in/social",
  "/forget-password",
  "/request-password-reset",
  "/reset-password",
  "/verify-email",
  "/send-verification-email",
  "/get-session",
  "/sign-out",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/mcp/register",
  "/ok",
  "/error",
]);

function isPublicAccountLifecyclePath(path: string): boolean {
  return (
    PUBLIC_ACCOUNT_LIFECYCLE_PATHS.has(path) ||
    /^\/callback\/[^/]+$/.test(path) ||
    /^\/reset-password\/[^/]+$/.test(path)
  );
}

/** Enforce persisted owner state before an MCP OAuth credential is consumed or disclosed. */
async function assertMcpOAuthAccountAccess(userId: string): Promise<void> {
  const [userData] = await getDatabase()
    .select({
      approvedAt: user.approvedAt,
      blocked: user.blocked,
      blockedReason: user.blockedReason,
      emailVerified: user.emailVerified,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  const denial = getAccountAccessDenial(
    {
      userId,
      approvedAt: userData?.approvedAt,
      blocked: !!userData?.blocked,
      emailVerified: !!userData?.emailVerified,
    },
    { requireEmailVerified: true },
  );
  if (denial === "blocked") {
    const reason = userData?.blockedReason ? `: ${userData.blockedReason}` : "";
    throw new APIError("FORBIDDEN", {
      message: `Account is blocked${reason}`,
      code: "ACCOUNT_BLOCKED",
    });
  }
  if (denial === "approval") {
    throw new APIError("FORBIDDEN", {
      message: "Account is awaiting administrator approval",
      code: ACCOUNT_APPROVAL_REQUIRED_CODE,
    });
  }
  if (denial === "email-verification") {
    throw new APIError("FORBIDDEN", {
      message: "Email verification required before authorizing applications",
      code: "EMAIL_NOT_VERIFIED",
    });
  }
}

/**
 * Check if request is valid load test request
 * @param email - User email from request
 * @param headers - Request headers
 * @returns true if valid load test request
 */
function isValidLoadTestRequest(
  email: string | undefined,
  headers: Headers | null | undefined,
): boolean {
  if (!email || !isLoadTestAuthEnabled()) {
    return false;
  }

  // Must use load test domain
  if (!email.endsWith(`@${LOAD_TEST_DOMAIN}`)) {
    return false;
  }

  // Must have valid X-Load-Test header
  const loadTestHeader = headers?.get("x-load-test");
  const loadTestSecret = getLoadTestSecret();

  if (!loadTestHeader || !loadTestSecret) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  try {
    return timingSafeEqual(Buffer.from(loadTestHeader), Buffer.from(loadTestSecret));
  } catch {
    // timingSafeEqual throws if lengths differ
    return false;
  }
}

// Base configuration (shared between services)
// Note: baseURL must include basePath for correct URL generation in emails
const baseConfig = {
  secret: getBetterAuthSecret(),

  baseURL: getAuthUrl(),

  // Additional user fields
  user: {
    additionalFields: {
      // Handle: unique user identifier for URLs and workflow references
      // Format: alphanumeric + hyphen, 4-40 chars, globally unique
      // Auto-generated from email prefix on registration
      handle: {
        type: "string" as const,
        required: false, // Set to false because Better Auth validates before databaseHooks runs
        input: false, // Not user-provided during sign-up - generated in databaseHooks.user.create.before
      },
      // Legal consent fields (GDPR compliance)
      acceptedTermsAt: {
        type: "string" as const,
        required: false, // Will be validated in hooks, not by Better Auth
        input: true, // Allow setting during sign-up
      },
      acceptedNotRussianResidentAt: {
        type: "string" as const,
        required: false,
        input: true,
      },
      approvedAt: {
        type: "string" as const,
        required: false,
        input: false,
      },
    },
  },

  advanced: {
    useSecureCookies: isProduction(),
  },

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // Session created immediately; emailVerified check in app middleware
    autoSignIn: true,
    minPasswordLength: 6,
    maxPasswordLength: 128,
    sendResetPassword: async ({
      user,
      url,
    }: {
      user: { id: string; email: string };
      url: string;
    }) => {
      if (!isEmailConfigured()) {
        logger.warn("Email not configured, skipping password reset email");
        return;
      }
      await sendEmail(user.id, "password_reset", {
        to: user.email,
        subject: "Reset your password - MCP Moira",
        text: `Click the link to reset your password: ${url}\n\nThis link will expire in 1 hour.\n\nIf you didn't request this, please ignore this email.`,
        html: `
          <h2>Reset Your Password</h2>
          <p>Click the button below to reset your password:</p>
          <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#3b82f6;color:white;text-decoration:none;border-radius:6px;">Reset Password</a></p>
          <p>Or copy this link: ${url}</p>
          <p><small>This link will expire in 1 hour. If you didn't request this, please ignore this email.</small></p>
        `,
      });
    },
  },

  emailVerification: {
    // saas sends a verification email on sign-up; self-host does not (no mail
    // server is assumed). Evaluated at config build — mode is fixed per process.
    sendOnSignUp: getFeatureResolver().isEnabled("verificationEmailOnSignup"),
    autoSignInAfterVerification: true, // Auto sign-in when user clicks verification link
    sendVerificationEmail: async ({
      user,
      url,
    }: {
      user: { id: string; email: string };
      url: string;
    }) => {
      if (!isEmailConfigured()) {
        logger.warn("Email not configured, skipping verification email");
        return;
      }
      // Fix callbackURL to go to /app instead of / (landing page)
      // Better Auth uses callbackURL=/ by default when not specified by client
      let fixedUrl = url;
      if (url.includes("callbackURL=%2F") || url.includes("callbackURL=/")) {
        fixedUrl = url
          .replace(/callbackURL=%2F(&|$)/, "callbackURL=%2Fapp$1")
          .replace(/callbackURL=\/(&|$)/, "callbackURL=/app$1");
      }
      await sendEmail(user.id, "verification", {
        to: user.email,
        subject: "Verify your email - MCP Moira",
        text: `Click the link to verify your email: ${fixedUrl}\n\nIf you didn't create an account, please ignore this email.`,
        html: `
          <h2>Verify Your Email</h2>
          <p>Click the button below to verify your email address:</p>
          <p><a href="${fixedUrl}" style="display:inline-block;padding:12px 24px;background:#10b981;color:white;text-decoration:none;border-radius:6px;">Verify Email</a></p>
          <p>Or copy this link: ${fixedUrl}</p>
          <p><small>If you didn't create an account, please ignore this email.</small></p>
        `,
      });
    },
  },

  // Social providers for OAuth. Gated by the socialLogin feature (off in
  // self-host, on in saas) AND by env-var presence — both must hold.
  socialProviders: {
    github: {
      clientId: getGitHubClientId() || "",
      clientSecret: getGitHubClientSecret() || "",
      enabled: getFeatureResolver().isEnabled("socialLogin") && !!getGitHubClientId(),
    },
    google: {
      clientId: getGoogleClientId() || "",
      clientSecret: getGoogleClientSecret() || "",
      enabled: getFeatureResolver().isEnabled("socialLogin") && !!getGoogleClientId(),
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60, // 1 hour
  },

  trustedOrigins: [getBaseUrl(), ...getExtraTrustedOrigins()],

  rateLimit: {
    enabled: false,
    customRules: {
      "/sign-up/email": false as const,
      "/sign-in/email": false as const,
      "/get-session": false as const,
      "*": false as const,
    },
  },

  plugins: [
    mcp({
      loginPage: "/oauth/authorize",
      resource: getMcpUrl(),
      oidcConfig: {
        loginPage: "/oauth/authorize",
        consentPage: "/oauth/consent",
      },
    }),
  ],

  databaseHooks: {
    user: {
      create: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        before: async (userData: any) => {
          // Auto-generate handle from email
          const email = userData.email as string;
          const baseHandle = generateHandleFromEmail(email);

          // Check for collision and add suffix if needed
          const db = getDatabase();
          let handle = baseHandle;
          let attempts = 0;
          const maxAttempts = 10;

          while (attempts < maxAttempts) {
            const [existing] = await db
              .select({ id: user.id })
              .from(user)
              .where(eq(user.handle, handle))
              .limit(1);

            if (!existing) {
              break; // Handle is unique
            }

            // Collision detected - add random suffix
            handle = `${baseHandle}-${generateRandomHandleSuffix()}`;
            attempts++;
          }

          if (attempts >= maxAttempts) {
            logger.error("Failed to generate unique handle after max attempts", { email });
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Failed to generate unique handle. Please try again.",
            });
          }

          logger.info("Generated handle for new user", { email, handle });
          return { data: { ...userData, handle } };
        },
      },
    },
    session: {
      create: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        before: async (session: any, ctx: any) => {
          // Check if user is blocked
          const db = getDatabase();
          const [userData] = await db
            .select()
            .from(user)
            .where(eq(user.id, session.userId))
            .limit(1);

          const denial = getAccountAccessDenial({
            userId: session.userId,
            blocked: !!userData?.blocked,
            approvedAt: userData?.approvedAt,
            emailVerified: !!userData?.emailVerified,
          });

          if (denial === "blocked") {
            // Log blocked login attempt
            const auditRepo = new AuditRepository(db);
            const ip =
              (ctx.headers?.get("x-forwarded-for") || ctx.headers?.get("x-real-ip") || "")
                .split(",")[0]
                .trim() || undefined;
            const geo = ip ? geoip.lookup(ip) : null;
            const country = geo?.country || undefined;
            const userAgent = ctx.headers?.get("user-agent") || undefined;

            await auditRepo.log({
              userId: session.userId,
              action: AuditAction.AUTH_SIGN_IN,
              resource: "user",
              resourceId: session.userId,
              ip,
              country,
              userAgent,
              metadata: JSON.stringify({
                blocked: true,
                reason: userData.blockedReason || "No reason provided",
              }),
            });

            logger.warn("Blocked user attempted login", {
              userId: session.userId,
              email: userData.email,
            });
            const reason = userData.blockedReason ? `: ${userData.blockedReason}` : "";
            throw new APIError("FORBIDDEN", {
              message: `Account is blocked${reason}`,
            });
          }

          // Extract IP and perform GeoIP lookup
          const ip = (ctx.headers?.get("x-forwarded-for") || ctx.headers?.get("x-real-ip") || "")
            .split(",")[0]
            .trim();
          const geo = ip ? geoip.lookup(ip) : null;
          const country = geo?.country || null;

          // Add country to session data
          return {
            data: {
              ...session,
              country,
            },
          };
        },
      },
    },
    oauthAccessToken: {
      create: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        before: async (token: any, ctx: any) => {
          // Check if user is blocked
          const db = getDatabase();
          const [userData] = await db.select().from(user).where(eq(user.id, token.userId)).limit(1);

          const denial = getAccountAccessDenial(
            {
              userId: token.userId,
              blocked: !!userData?.blocked,
              approvedAt: userData?.approvedAt,
              emailVerified: !!userData?.emailVerified,
            },
            { requireEmailVerified: true },
          );

          if (denial === "blocked") {
            // Log blocked OAuth token creation attempt
            const auditRepo = new AuditRepository(db);
            const ip =
              (ctx.headers?.get("x-forwarded-for") || ctx.headers?.get("x-real-ip") || "")
                .split(",")[0]
                .trim() || undefined;
            const geo = ip ? geoip.lookup(ip) : null;
            const country = geo?.country || undefined;
            const userAgent = ctx.headers?.get("user-agent") || undefined;

            await auditRepo.log({
              userId: token.userId,
              action: AuditAction.AUTH_SIGN_IN,
              resource: "oauthAccessToken",
              resourceId: token.userId,
              ip,
              country,
              userAgent,
              metadata: JSON.stringify({
                blocked: true,
                reason: userData.blockedReason || "No reason provided",
                clientId: token.clientId,
              }),
            });

            logger.warn("Blocked user attempted OAuth authorization", {
              userId: token.userId,
              email: userData.email,
              clientId: token.clientId,
            });
            const reason = userData.blockedReason ? `: ${userData.blockedReason}` : "";
            throw new APIError("FORBIDDEN", {
              message: `Account is blocked${reason}`,
            });
          }

          if (denial === "approval") {
            logger.warn("Pending user attempted OAuth token creation", {
              userId: token.userId,
              clientId: token.clientId,
            });
            throw new APIError("FORBIDDEN", {
              message: "Account is awaiting administrator approval",
              code: ACCOUNT_APPROVAL_REQUIRED_CODE,
            });
          }

          // Check email verification - required for OAuth access (saas only).
          // In self-host the email-verification gate is off so an MCP client can
          // authorize without a configured mail server.
          if (denial === "email-verification") {
            logger.warn("Unverified user attempted OAuth authorization", {
              userId: token.userId,
              email: userData?.email,
              clientId: token.clientId,
            });
            throw new APIError("FORBIDDEN", {
              message: "Email verification required before authorizing applications",
            });
          }

          // Note: toolsVersion is set in hooks.after on /mcp/token path
          // because MCP plugin uses adapter.create directly which bypasses databaseHooks
          return { data: token };
        },
      },
    },
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Registration is deployment-configurable. Self-host enables it together
      // with the independent account-approval gate.
      if (
        ctx.path === "/sign-up/email" &&
        !getFeatureResolver().isEnabled("openRegistration") &&
        !isValidLoadTestRequest(ctx.body?.email, ctx.headers)
      ) {
        throw new APIError("FORBIDDEN", {
          message: "Open registration is disabled. Contact your administrator for an account.",
          code: "REGISTRATION_DISABLED",
        });
      }

      // Better Auth endpoints bypass the Express product middleware. Apply the
      // same persisted account-state boundary to every authenticated endpoint.
      // Public and token-authorized identity lifecycle operations remain
      // independent from an incidental browser session.
      if (!isPublicAccountLifecyclePath(ctx.path)) {
        const session = await getSessionFromCtx(ctx);
        if (session?.user.id) {
          const [userData] = await getDatabase()
            .select({ approvedAt: user.approvedAt, blocked: user.blocked })
            .from(user)
            .where(eq(user.id, session.user.id))
            .limit(1);
          const denial = getAccountAccessDenial({
            userId: session.user.id,
            approvedAt: userData?.approvedAt,
            blocked: !!userData?.blocked,
            emailVerified: true,
          });
          if (denial === "blocked") {
            throw new APIError("FORBIDDEN", {
              message: "Account is blocked",
              code: "ACCOUNT_BLOCKED",
            });
          }
          if (denial === "approval") {
            throw new APIError("FORBIDDEN", {
              message: "Account is awaiting administrator approval",
              code: ACCOUNT_APPROVAL_REQUIRED_CODE,
            });
          }
        }
      }

      // The MCP plugin writes tokens through its adapter and bypasses
      // databaseHooks.oauthAccessToken. Resolve the owner from the refresh token
      // or authorization code before the plugin consumes either credential.
      if (ctx.path.endsWith("/mcp/token") && ctx.method === "POST") {
        const body = ctx.body as
          | { grant_type?: string; refresh_token?: string; code?: string }
          | undefined;
        let userId: string | undefined;

        if (body?.grant_type === "refresh_token" && body.refresh_token) {
          const [tokenData] = await getDatabase()
            .select({ userId: oauthAccessToken.userId })
            .from(oauthAccessToken)
            .where(eq(oauthAccessToken.refreshToken, body.refresh_token))
            .limit(1);
          userId = tokenData?.userId;
        } else if (body?.code) {
          const verificationValue = await ctx.context.internalAdapter.findVerificationValue(
            body.code,
          );
          if (verificationValue) {
            try {
              userId = (JSON.parse(verificationValue.value) as { userId?: string }).userId;
            } catch {
              // The plugin will return its normal invalid-code response.
            }
          }
        }

        if (userId) await assertMcpOAuthAccountAccess(userId);
      }

      // The plugin's bearer introspection endpoint reads oauthAccessToken
      // directly and otherwise bypasses both cookie-session and token-exchange
      // checks. Recheck the persisted owner state before disclosing token data.
      if (ctx.path.endsWith("/mcp/get-session") && ctx.method === "GET") {
        const accessToken = ctx.headers?.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (accessToken) {
          const [tokenData] = await getDatabase()
            .select({ userId: oauthAccessToken.userId })
            .from(oauthAccessToken)
            .where(eq(oauthAccessToken.accessToken, accessToken))
            .limit(1);
          if (tokenData?.userId) await assertMcpOAuthAccountAccess(tokenData.userId);
        }
      }

      // Validate legal consent on sign-up (saas only). In self-host registration
      // does not require terms/residency consent.
      if (ctx.path === "/sign-up/email" && getFeatureResolver().isEnabled("legalConsents")) {
        const { acceptedTermsAt, acceptedNotRussianResidentAt } = ctx.body || {};

        if (!acceptedTermsAt) {
          throw new APIError("BAD_REQUEST", {
            message: "You must accept the Terms of Service and Privacy Policy to register.",
            code: "TERMS_NOT_ACCEPTED",
          });
        }

        if (!acceptedNotRussianResidentAt) {
          throw new APIError("BAD_REQUEST", {
            message: "You must confirm that you are not a resident of the Russian Federation.",
            code: "RESIDENCY_NOT_CONFIRMED",
          });
        }
      }

      // Handle re-registration of unverified user
      // Instead of "User already exists" error, redirect to resend verification form.
      // Only relevant when the email-verification gate is on (saas); in self-host
      // there is no verification step, so this resend flow is skipped.
      if (
        ctx.path === "/sign-up/email" &&
        ctx.body?.email &&
        getFeatureResolver().isEnabled("emailVerificationGate")
      ) {
        const db = getDatabase();
        const existingUser = await db
          .select({
            id: user.id,
            emailVerified: user.emailVerified,
          })
          .from(user)
          .where(eq(user.email, ctx.body.email))
          .limit(1);

        if (existingUser.length > 0 && !existingUser[0].emailVerified) {
          // User exists but email not verified - throw special error for frontend
          throw new APIError("BAD_REQUEST", {
            message:
              "Email not verified. Please check your inbox or request a new verification email.",
            code: "EMAIL_NOT_VERIFIED_RESEND",
            cause: { userId: existingUser[0].id, email: ctx.body.email },
          });
        }
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      try {
        const newSession = ctx.context.newSession;
        const auditRepo = new AuditRepository(getDatabase());
        const db = getDatabase();

        // Extract request metadata for audit logging
        const ip =
          (ctx.headers?.get("x-forwarded-for") || ctx.headers?.get("x-real-ip") || "")
            .split(",")[0]
            .trim() || undefined;
        const geo = ip ? geoip.lookup(ip) : null;
        const country = geo?.country || undefined;
        const userAgent = ctx.headers?.get("user-agent") || undefined;

        // Auto-verify load test users after sign-up
        // This allows them to immediately use authenticated endpoints
        if (ctx.path === "/sign-up/email" && newSession) {
          const email = newSession.user.email;
          const isLoadTest = isValidLoadTestRequest(email, ctx.headers);

          if (isLoadTest) {
            // Load-test identities are an explicit test-only exception to both
            // verification and approval so existing load suites remain usable.
            await db
              .update(user)
              .set({ emailVerified: true, approvedAt: new Date().toISOString() })
              .where(eq(user.id, newSession.user.id));

            logger.info("Load test user auto-verified", {
              userId: newSession.user.id,
              email,
            });
          }
        }

        // Sign-up events
        if (ctx.path.startsWith("/sign-up") && newSession) {
          const email = newSession.user.email;
          const isLoadTest = isValidLoadTestRequest(email, ctx.headers);

          const metadata = JSON.stringify({
            email: newSession.user.email,
            name: newSession.user.name,
            provider: ctx.path.includes("/email") ? "email" : "oauth",
            loadTest: isLoadTest || undefined,
          });
          await auditRepo.log({
            userId: newSession.user.id,
            action: AuditAction.AUTH_SIGN_UP,
            resource: "user",
            resourceId: newSession.user.id,
            ip,
            country,
            userAgent,
            metadata,
          });
          logger.info("Audit: User sign-up", {
            userId: newSession.user.id,
            email: newSession.user.email,
            loadTest: isLoadTest,
          });
        }

        // Sign-in events (email + OAuth)
        if (ctx.path.startsWith("/sign-in") && newSession) {
          const metadata = JSON.stringify({
            provider: ctx.path.includes("/email")
              ? "email"
              : ctx.path.includes("/social")
                ? "oauth"
                : "unknown",
          });
          await auditRepo.log({
            userId: newSession.user.id,
            action: AuditAction.AUTH_SIGN_IN,
            resource: "session",
            resourceId: newSession.session.id,
            ip,
            country,
            userAgent,
            metadata,
          });
          logger.info("Audit: User sign-in", {
            userId: newSession.user.id,
            sessionId: newSession.session.id,
          });
        }

        // Sign-out events
        if (ctx.path === "/sign-out") {
          const session = ctx.context.session;
          if (session) {
            await auditRepo.log({
              userId: session.user.id,
              action: AuditAction.AUTH_SIGN_OUT,
              resource: "session",
              resourceId: session.session.id,
              ip,
              country,
              userAgent,
              metadata: undefined,
            });
            logger.info("Audit: User sign-out", {
              userId: session.user.id,
              sessionId: session.session.id,
            });
          }
        }

        // MCP OAuth token creation - add version (#196)
        // Note: databaseHooks.oauthAccessToken.create.before is NOT called by MCP plugin
        // because it uses adapter.create directly, so we update the token in after hook
        // Path can be /mcp/token (direct) or /api/auth/mcp/token (via API prefix)
        if (ctx.path.endsWith("/mcp/token") && ctx.method === "POST") {
          const mcpVersion = getMcpServerVersion();
          if (mcpVersion) {
            try {
              // Get the access token from the response body to find the correct token
              // ctx.context.returned contains the response - may be JSON or Response object
              const returned = ctx.context.returned as
                | { access_token?: string }
                | Response
                | undefined;
              let accessToken: string | undefined;

              if (returned && "access_token" in returned) {
                // Direct JSON response
                accessToken = returned.access_token;
              }

              if (!accessToken) {
                logger.warn("Could not extract access_token from MCP token response", {
                  returnedType: typeof returned,
                });
                return;
              }

              // Find and update the token by its accessToken value
              const db = getDatabase();
              const [tokenToUpdate] = await db
                .select({ id: oauthAccessToken.id })
                .from(oauthAccessToken)
                .where(eq(oauthAccessToken.accessToken, accessToken))
                .limit(1);

              if (tokenToUpdate) {
                await db
                  .update(oauthAccessToken)
                  .set({ toolsVersion: mcpVersion })
                  .where(eq(oauthAccessToken.id, tokenToUpdate.id));

                logger.info("MCP OAuth token version recorded", {
                  tokenId: tokenToUpdate.id,
                  version: mcpVersion,
                });
              } else {
                logger.warn("Token not found by accessToken", {
                  accessTokenPrefix: accessToken.substring(0, 8) + "...",
                });
              }
            } catch (updateError) {
              logger.error("Failed to record MCP token version", updateError);
            }
          }
        }
      } catch (error) {
        logger.error("Auth audit logging failed", error);
      }
    }),
  },
};

/**
 * Create Better Auth instance with service-specific error logging
 */
export function createAuth(logger: ServiceLogger) {
  const config: BetterAuthOptions = {
    ...baseConfig,
    database: getSqliteInstance(),
    logger: {
      disabled: false,
      level: "error",
      log: (level, message, ...args) => {
        const metadata = args.length > 0 ? args[0] : undefined;
        switch (level) {
          case "error":
            logger.error(message, undefined, metadata);
            break;
          case "warn":
            logger.warn(message, metadata);
            break;
          case "info":
            logger.info(message, metadata);
            break;
          case "debug":
            logger.debug(message, metadata);
            break;
          default:
            logger.info(message, metadata);
        }
      },
    },
    onAPIError: {
      throw: false,
      onError: (error, ctx) => {
        const req = (ctx as unknown as { request?: { url?: string; method?: string } }).request;
        logger.error("Better Auth API error", error, {
          path: req?.url,
          method: req?.method,
          status: (error as { status?: number }).status,
        });
      },
    },
  };

  return betterAuth(config);
}
