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

SaaS registration requires explicit consent for GDPR compliance. Self-host
registration does not request or validate these consent fields.

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

## Self-Host Account Approval

Self-host registration is public, but a new account is pending until an
administrator approves it. Approval is stored in `user.approvedAt` and is
independent from `emailVerified`, `blocked`, and `isAdmin`.

- `GET /api/user/me` is the session-only status endpoint. It returns
  `approvedAt`, `accountApproved`, and `accountApprovalRequired` for pending users.
- `POST /api/auth/sign-out` remains available through Better Auth.
- Product APIs, API-token creation, OAuth authorization and token issuance, and MCP
  requests return 403 with `ACCOUNT_APPROVAL_REQUIRED` while approval is required
  and absent.
- `POST /api/admin/users/:id/approve` performs a conditional transition and the
  `admin:approve_user` audit insert in one SQLite transaction. Repeated or
  overlapping requests return the original timestamp and create one audit event.
- Migration `0014_account_approval` marks existing users approved. Bootstrap and
  recovery administrators are explicitly created or repaired as approved.

SaaS has `accountApproval` disabled, so a null `approvedAt` does not change its
existing email-verification and legal-consent flow. A blocked account is always
denied before approval or email state is considered.

### Recover Administrator Access

Run the recovery command from the directory containing `docker-compose.yml`.
Read the new password without echoing it or storing it in shell history:

```bash
read -s ADMIN_PASSWORD
export ADMIN_PASSWORD
docker compose exec -e ADMIN_PASSWORD moira npx tsx scripts/create-admin-user.ts
unset ADMIN_PASSWORD
```

`ADMIN_PASSWORD` is required. The optional `ADMIN_EMAIL` and `ADMIN_ID`
environment variables default to `admin@moira.local` and `system-admin`; pass
overrides with additional `docker compose exec -e NAME` arguments. `DB_PATH`
defaults to `./data/moira.db`. The command creates or repairs the administrator,
marks its email verified and account approved, clears any account block, and
replaces its credential with the supplied password. It prints the email and user
ID, never the password.

### Roll Back to a Version Without Account Approval

An older binary does not understand `user.approvedAt`. Before pinning an image
that predates account approval, put the instance into maintenance or otherwise
stop external traffic, back up the database, and run this command on the current
approval-aware image:

```bash
docker compose exec moira npm run prepare:account-approval-downgrade -- \
  --confirm-block-pending-users
```

The command refuses to run without the confirmation argument or without the
`approvedAt` column. In one database transaction it marks every pending account
with the legacy `blocked` control and revokes its sessions, API tokens, OAuth
tokens, and OAuth consents. Verify the printed counts before stopping the current
container and starting the older image. Do not roll back first: the old image
cannot perform this conversion and would otherwise admit pending users. If the
approval-aware version is restored later, review each converted account before
approving it and explicitly unblocking it.

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
  → account approval check when accountApproval is enabled
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
- `403 Forbidden` — user account blocked or awaiting required approval

**Token management APIs:**

- `POST /api/tokens` — create token (user)
- `GET /api/tokens` — list own tokens (user)
- `DELETE /api/tokens/:id` — revoke own token (user)
- `GET /api/admin/tokens` — list all tokens (admin)
- `DELETE /api/admin/tokens/:id` — revoke any token (admin)

**UI management:** Settings page (`/app/settings`) → API Tokens section. Users can create tokens with name and expiration, view token list with status badges, copy token value on creation (shown once), and revoke tokens with confirmation dialog.

## Email Delivery

`GET /api/features` exposes the effective `emailDelivery` capability without
credentials. Its state is `real`, `test`, `unavailable`, or
`configuration-error`. Only `real` means that password-reset and verification
messages can reach users.

Self-host deployments can configure generic SMTP or Brevo as described in
`docs/deployment/ENVIRONMENT_VARIABLES.md`. Without a real provider, startup
continues, but forgot-password, resend-verification, and administrator email
actions are unavailable in both the API and UI. SaaS startup fails unless a real
provider is configured. The explicit `test` provider and test-recipient sink log
messages for automated testing and never report them as sent.

### Recover an Ordinary User Without Email

When a self-host instance has no real email provider, an administrator can open
the ordinary user's detail page and choose **Set temporary password**. The
administrator must transmit that password through a separate secure channel.

`POST /api/admin/users/:id/temporary-password` accepts
`{ "temporaryPassword": "..." }` for a non-admin target. It replaces the
credential, revokes all sessions, persistent API tokens, OAuth access tokens,
OAuth consents, and linked-provider tokens, and sets `passwordResetRequired`.
The next login succeeds only with the temporary password and redirects the user
to `/app/force-password-reset`, where the user must choose a new password. The
audit event records revocation counts and never records the temporary password.
Administrator accounts use the command-line recovery procedure in **Recover
Administrator Access** instead.

## Email Verification

SaaS users must verify their email address before sensitive access. Self-host
keeps email verification separate and does not use it as an access gate.

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

**SaaS User Flow:**

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

- Set `EMAIL_PROVIDER=test`; `TestEmailProvider` logs verification URLs to
  backend logs and the public delivery capability remains `test`, not `real`
- Check: `docker exec <container> cat /var/log/supervisor/backend-api.log | grep "Email URLs"`

## Blocked Users

Blocked users cannot access the system through any method.

**Web UI Login:**

- `databaseHooks.session.create.before` hook checks `user.blocked` flag
- Throws "Account is blocked" error before session creation
- Error displays in login form via AuthErrorDisplay component

**MCP OAuth Token Issuance:**

- The Better Auth `before` hook resolves the owner of authorization-code and refresh-token grants
  before the MCP plugin consumes either credential. The plugin writes through its adapter and does
  not invoke `databaseHooks.oauthAccessToken.create.before`.
- The shared admission decision rejects blocked accounts first, pending self-host accounts second,
  and unverified SaaS accounts third, with `ACCOUNT_BLOCKED`, `ACCOUNT_APPROVAL_REQUIRED`, or
  `EMAIL_NOT_VERIFIED` respectively.

**MCP Requests with Existing OAuth Tokens:**

- After session validation, the MCP server applies the same shared admission decision to the token
  owner. This prevents blocked, pending, and unverified identities from using already-issued or
  legacy OAuth tokens after policy/state changes.
- Better Auth's `/mcp/get-session` bearer introspection applies the same owner-state decision before
  returning the stored OAuth token record, including its refresh token.
- Rejections are HTTP 403 with the same stable machine error codes used at token issuance.

**Existing Sessions:**

- `requireAuth` middleware checks `user.blocked` flag on every request
- Returns 403 Forbidden and invalidates current session
- Non-public Better Auth session operations apply the same blocked-first decision in both deployment
  modes and return `ACCOUNT_BLOCKED`; public sign-in/out and one-time-token lifecycle operations keep
  their own authentication semantics
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

When an administrator requires a user to change an existing or newly assigned
temporary password:

**User Flow:**

1. User logs in normally
2. Middleware detects the `passwordResetRequired` flag
3. Redirects to `/app/force-password-reset`
4. User enters the current or temporary password and a new password
5. Auto-login with new credentials via `authClient.signIn.email()`
6. Redirects to /app/workflows

**Middleware:** packages/web-frontend/src/middleware/ForcedPasswordResetMiddleware.tsx

**Admin Actions:**

- Set temporary password: Replaces the credential, sets the reset flag, and
  revokes sessions, persistent API tokens, OAuth tokens, OAuth consents, and
  linked-provider tokens
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
npm run test:e2e

# Custom Docker port
TEST_BASE_URL=http://localhost:3031 npm test

# Production
TEST_BASE_URL=https://moira.example.com npm test
```

**Available test commands:**

```bash
# Playwright E2E on Docker (default)
npm run test:e2e

# One Playwright E2E file
npm run test:e2e -- --file tests/e2e/oauth-consent.spec.ts

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
