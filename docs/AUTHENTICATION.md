# Authentication

## Setup

```bash
# Database migration
npx tsx scripts/run-migrations.ts
```

## Configuration

Environment variables (.env.local):

```bash
# URL Configuration (protocol auto-detected: localhost=http, else=https)
MOIRA_HOST=localhost:${DOCKER_PORT}

BETTER_AUTH_SECRET=your-secret-key

# Database path
DB_PATH=./data/moira.db

# Admin user (for migration)
ADMIN_EMAIL=admin@moira.local
ADMIN_PASSWORD=your-admin-password

# GitHub OAuth (optional)
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-secret

# Google OAuth (optional)
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-secret
```

Database:

- Path from DB_PATH env (default: ./data/moira.db)
- Unified Drizzle ORM migrations (Better Auth + Workflow tables)
- Admin user seeded from ADMIN_PASSWORD env

## Better Auth Instances

Better Auth is created in each service with service-specific error logging:

**Web Backend** (packages/web-backend/src/auth.ts):

```typescript
import { createAuth, createLogger, Service } from "@mcp-moira/shared";

const logger = createLogger({ service: Service.WEB_BACKEND, component: "BetterAuth" });
export const auth = createAuth(logger);
```

**MCP Server** (packages/mcp-server/src/auth.ts):

```typescript
import { createAuth, createLogger, Service } from "@mcp-moira/shared";

const logger = createLogger({ service: Service.MCP_SERVER, component: "BetterAuth" });
export const auth = createAuth(logger);
```

**Shared Config** (packages/shared/src/auth/better-auth-config.ts):

```typescript
export function createAuth(logger: ServiceLogger) {
  return betterAuth({
    ...baseConfig,
    onAPIError: {
      throw: false,
      onError: (error, ctx) => {
        logger.error("Better Auth API error", error, {
          path: ctx.request?.url,
          status: error.status,
        });
      },
    },
  });
}
```

## Admin Access Control

**Middleware**: packages/web-backend/src/middleware/admin-middleware.ts

`requireAdmin` middleware protects admin-only routes. It runs after `requireAuth`
(which populates `req.userId`), checks the admin role via `checkAdminRole`, and
throws `AppError` classes that are handled at the HTTP boundary by
`error-middleware.ts`:

```typescript
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const userId = (req as AuthenticatedRequest).userId; // From requireAuth middleware
  if (!userId) {
    throw new AuthenticationError("Authentication required");
  }
  const isAdmin = await checkAdminRole(userId);
  if (!isAdmin) {
    throw new AuthorizationError("Admin permission required");
  }
  next();
}
```

**Protected Routes** (packages/web-backend/src/routes/admin.ts):

- GET /api/admin/audit-log
- POST /api/admin/settings/definitions
- PUT /api/admin/settings/definitions/:key
- DELETE /api/admin/settings/definitions/:key
- POST /api/admin/executions/:id/context
- POST /api/admin/database/vacuum
- POST /api/admin/database/backup
- GET /api/admin/status
- GET /api/admin/tokens
- DELETE /api/admin/tokens/:id

**Frontend Guards** (packages/web-frontend/src/App.tsx):

Admin routes are wrapped in `<ProtectedRoute requireAdmin>`, which renders the
admin area only for admins and redirects others away:

```tsx
<Route
  path="/app/admin/*"
  element={
    <ProtectedRoute requireAdmin>
      <AdminLayout />
    </ProtectedRoute>
  }
/>
```

Non-admin users receive 403 Forbidden from the API and are redirected by the route guard.

## Browser Authentication

**Email/password:** http://localhost:${DOCKER_PORT}/login

**GitHub OAuth:** Click GitHub button on login page

**Registration:** http://localhost:${DOCKER_PORT}/register

## Deep Link Preservation (returnUrl)

When an unauthenticated user visits a protected route (e.g., `/app/admin/audit-log`), the system preserves the intended URL through the login flow:

1. `ProtectedRoute` redirects to `/app/login?returnUrl=%2Fapp%2Fadmin%2Faudit-log`
2. `Login` page reads `returnUrl` from search params and passes it as `redirectTo` to Better Auth
3. After successful login, user is redirected to the original URL
4. `returnUrl` is preserved when navigating between login/register views

**Security** (`packages/web-frontend/src/utils/return-url.ts`):

- Only `/app/*` paths accepted (rejects external URLs, protocol-relative, `javascript:`, `data:`)
- Path traversal (`../`) blocked
- Login/register paths rejected to prevent redirect loops
- Invalid URLs fall back to `/app`

**401/403 handling**: `useAuthErrorHandler` hook preserves the current URL as `returnUrl` when redirecting to login on auth errors.

## Registration Consent Requirements

Registration requires explicit consent for GDPR compliance:

**Required Checkboxes:**

1. **Terms of Service and Privacy Policy** - User must accept legal documents
2. **Non-Russian Resident Confirmation** - Geographic restriction for alpha release

**Backend Validation** (packages/shared/src/auth/better-auth-config.ts):

```typescript
// beforeCreate hook validates consent fields
if (!acceptedTermsAt) {
  throw new APIError("BAD_REQUEST", {
    code: "TERMS_NOT_ACCEPTED",
    message: "You must accept the Terms of Service and Privacy Policy",
  });
}
if (!acceptedNotRussianResidentAt) {
  throw new APIError("BAD_REQUEST", {
    code: "RESIDENCY_NOT_CONFIRMED",
    message: "You must confirm you are not a resident of Russian Federation",
  });
}
```

**Frontend Implementation** (packages/web-frontend/src/auth/AuthProvider.tsx):

- Uses `@daveyplate/better-auth-ui` AuthUIProvider with `additionalFields`
- Checkboxes rendered as boolean fields with required validation
- Timestamps stored in user record: `acceptedTermsAt`, `acceptedNotRussianResidentAt`

**Legal Documents:**

The registration form links to legal documents at the `/terms` and `/privacy`
paths (see `packages/web-frontend/src/auth/AuthProvider.tsx`). These pages are
served by the deployment's front-of-house site, which is not part of this
repository; self-hosters provide their own Terms of Service and Privacy Policy at
those paths.

**Error Codes:**

| Code                      | Meaning                               |
| ------------------------- | ------------------------------------- |
| `TERMS_NOT_ACCEPTED`      | Terms checkbox not checked            |
| `RESIDENCY_NOT_CONFIRMED` | Russian resident checkbox not checked |

## MCP Authentication

MCP clients use OAuth 2.1 authorization flow:

1. Client connects to http://localhost:${DOCKER_PORT}/mcp
2. Receives HTTP 401 with OAuth discovery URL
3. Fetches `/.well-known/oauth-protected-resource`
4. Fetches `/.well-known/oauth-authorization-server`
5. Opens `authorization_endpoint` in browser
6. User logs in at `/oauth/authorize`
7. User sees consent screen with requested permissions
8. User clicks Allow to grant access
9. Consent saved to database for future auto-approval
10. Client receives access token via redirect
11. Reconnects with `Authorization` header

### OAuth Consent Flow

**First authorization:**

- User sees consent screen after login
- Displays requested scopes (openid, profile, email, offline_access)
- Allow grants access and saves consent
- Deny redirects with error

**Repeat authorization:**

- System checks oauthConsent table
- Auto-approves if consent exists
- User skips consent screen

**API Endpoints:**

- `GET /api/oauth/consent/check?client_id=X` - Check existing consent
- `POST /api/oauth/consent` - Save consent (body: `{client_id, scopes}`)

### Persistent Token Authentication

MCP clients can authenticate with persistent API tokens instead of OAuth:

1. User creates a token via REST API (`POST /api/tokens`)
2. Token format: `moira_<random_bytes>` (prefix-based discrimination)
3. Client sends `Authorization: Bearer moira_...` header
4. Server detects `moira_` prefix → persistent token auth path

**Auth flow:**

```
Bearer token received
  → isPersistentToken() (prefix check)
  → hashToken() (SHA-256)
  → DB lookup in apiToken table
  → validateTokenRecord() (exists, not revoked, not expired)
  → user blocked check
  → fire-and-forget lastUsedAt update
  → build userContext
  → MCP execution
```

**Differences from OAuth:**

- No version check (HTTP 426) — persistent tokens have no `toolsVersion`
- No session/consent management
- Token revocation is immediate (DB lookup on each request)

**Client setup instructions:**

All client setup pages (landing QuickStart, docs quickstart, docs MCP clients) include a collapsible "Authentication without OAuth" section per non-GUI client tab. Config examples use `moira_YOUR_TOKEN` placeholder with Bearer token in the Authorization header.

**Error responses:**

- `401 Unauthorized` — invalid, expired, or revoked token
- `403 Forbidden` — user account blocked

**Token management APIs:**

- `POST /api/tokens` — create token (user)
- `GET /api/tokens` — list own tokens (user)
- `DELETE /api/tokens/:id` — revoke own token (user)
- `GET /api/admin/tokens` — list all tokens (admin)
- `DELETE /api/admin/tokens/:id` — revoke any token (admin)

**UI management:** Settings page (`/app/settings`) → API Tokens section. Users can create tokens with name and expiration, view token list with status badges, copy token value on creation (shown once), and revoke tokens with confirmation dialog.

## Email Verification

Users must verify their email address before accessing protected pages.

**Architecture:**

- `requireEmailVerification: false` in Better Auth - session created immediately after registration
- `autoSignInAfterVerification: true` - auto sign-in when clicking verification link
- Frontend `ProtectedRoute` component enforces verification via `requireEmailVerified` prop
- Backend `requireVerifiedAuth` middleware enforces verification for sensitive operations

**Frontend Protection** (packages/web-frontend/src/components/ProtectedRoute.tsx):

```typescript
export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requireAdmin = false,
  requireEmailVerified = true, // Default: require verified email
}) => {
  // Fetches emailVerified from /api/user/me
  // Redirects unverified users to /app/registration-success
};
```

**Backend Protection** (packages/web-backend/src/middleware/auth-middleware.ts):

```typescript
export const requireVerifiedAuth = async (req, res, next) => {
  // Checks session.user.emailVerified
  // Returns 403 if not verified
};
```

**User Flow:**

1. User registers at /app/register
2. Session created immediately (UX: can see "verify email" page)
3. User redirected to /app/registration-success with polling
4. Verification email sent with link
5. User can click "Resend verification email" button (60 second rate limit)
6. User clicks link, email verified, auto-redirected to /app

**Resend Verification Email:**

- Button appears on /app/registration-success after email extracted from session
- Uses `authClient.sendVerificationEmail()` API
- Server-side rate limiting: 60 second cooldown between sends (in-memory Map)
- Frontend receives cooldownSeconds from server response
- Button disabled with countdown timer during cooldown
- Shows success/error alert feedback

**Re-registration with Unverified Email:**

- If user tries to register with an existing unverified email
- Better Auth before hook intercepts the request
- Returns error code `EMAIL_NOT_VERIFIED_RESEND`
- Frontend AuthProvider detects this error and redirects to /app/registration-success
- User can resend verification email from that page

**Testing Email Verification:**

- TestEmailProvider logs verification URLs to backend logs
- Check: `docker exec <container> cat /var/log/supervisor/backend-api.log | grep "Email URLs"`

## Blocked Users

Blocked users cannot access the system through any method.

**Web UI Login:**

- `databaseHooks.session.create.before` hook checks `user.blocked` flag
- Throws "Account is blocked" error before session creation
- Error displays in login form via AuthErrorDisplay component

**MCP OAuth Authorization:**

- `databaseHooks.oauthAccessToken.create.before` hook checks `user.blocked` flag
- Throws "Account is blocked" error before token creation
- Prevents OAuth authorization for blocked users

**MCP Requests with Existing OAuth Tokens:**

- MCP server checks `user.blocked` flag after session validation
- Returns 403 with "Account is blocked" error if user blocked
- Prevents blocked users from executing MCP tools even with valid OAuth tokens

**Existing Sessions:**

- `requireAuth` middleware checks `user.blocked` flag on every request
- Returns 403 Forbidden and invalidates current session
- Immediate logout on next API call

## API Client Error Handling

Frontend API client (packages/web-frontend/src/services/api-client.ts) intercepts 401/403 responses:

**Behavior:**

- 401 Unauthorized: Shows "Session Expired" toast, signs out, redirects to /login
- 403 Forbidden: Shows "Access Denied" toast with server error message, signs out, redirects to /login
- Public auth endpoints excluded from interception (login, register, forgot-password, etc.)

**Implementation:**

```typescript
// api-client.ts
// PUBLIC_AUTH_ENDPOINTS lists the specific Better Auth sign-in/up/out,
// password, verify-email, and session endpoints (both /api/auth/* and
// the relative /auth/* variants the axios interceptor sees).
const PUBLIC_AUTH_ENDPOINTS = ["/api/auth/sign-in", "/auth/sign-in" /* , ... */];

type AuthErrorHandler = (status: number, message: string) => void;
export const setAuthErrorHandler = (handler: AuthErrorHandler | null): void => { ... };

// useAuthErrorHandler.ts hook registers the callback in AuthProvider
```

**Infinite Redirect Prevention:**

- Hook tracks if redirect is in progress (isHandlingRef)
- Skips redirect if already on auth pages (/login, /register, etc.)

## Forced Password Reset

When admin forces password reset for a user:

**User Flow:**

1. User logs in normally
2. Middleware detects `forcePasswordReset` flag
3. Redirects to /auth/forced-password-reset
4. User enters new password
5. Auto-login with new credentials via `authClient.signIn.email()`
6. Redirects to /app/workflows

**Middleware:** packages/web-frontend/src/middleware/ForcedPasswordResetMiddleware.tsx

**Admin Actions:**

- Block user: Sets flag + deletes sessions + deletes OAuth tokens + deletes consents
- Revoke sessions: Deletes sessions + deletes OAuth tokens + deletes consents
- All revocations audited with counts

## Testing

### Integration and E2E Tests

**CRITICAL REQUIREMENTS:**

1. **All integration/E2E tests MUST use `getTestBaseUrl()` utility from `tests/utils/test-config.ts`**
2. **NO hardcoded URLs or ports ANYWHERE in tests**
3. **Tests run against Docker by default** (localhost:DOCKER_PORT from .env.local)
4. **Override with TEST_BASE_URL env variable** for production or other environments

**Default behavior:**

```typescript
// tests/utils/test-config.ts
export function getTestBaseUrl(): string {
  if (process.env.TEST_BASE_URL) return process.env.TEST_BASE_URL;
  const dockerPort = process.env.DOCKER_PORT || "3032";
  return `http://localhost:${dockerPort}`;
}
```

**Running tests:**

```bash
# Default: Docker local (localhost:${DOCKER_PORT} from .env.local)
npm run test:e2e:docker

# Custom Docker port
TEST_BASE_URL=http://localhost:3031 npm test

# Production
TEST_BASE_URL=https://moira.example.com npm test
```

**Available test commands:**

```bash
# Playwright E2E on Docker (default)
npm run test:e2e

# Playwright E2E on specific environment
npm run test:e2e:local

# Jest integration tests (uses Docker by default)
npm run test:integration

# All tests
npm test
```

### Manual Testing

**Docker (recommended):**

```bash
npm run docker:restart
# Open http://localhost:${DOCKER_PORT}/login
```

### MCP Inspector Testing

```bash
# Docker
{"url": "http://localhost:${DOCKER_PORT}/mcp", "type": "http"}

# Follow OAuth flow in browser
```

## Troubleshooting

**MCP returns 401:** Expected - authenticate via OAuth flow

**Session cookie not set:** Check `useSecureCookies` (false for dev HTTP, true for production HTTPS)

**GitHub OAuth fails:** Verify `GITHUB_CLIENT_ID` and callback URL `http://localhost:${DOCKER_PORT}/oauth/authorize` configured in GitHub app settings

**Discovery endpoints 404:** Check `/.well-known/*` routes added before catch-all routes in web-backend server.ts

**Database errors:** Verify database exists at DB_PATH location and migrations completed (`npx tsx scripts/run-migrations.ts`)
