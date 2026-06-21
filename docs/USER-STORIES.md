# User Stories - MCP Moira

End-to-end user journeys, from first contact to a working workflow.

> **Note on paths.** These journeys describe the hosted deployment where the Web UI
> is served under `/app` and a brand landing page lives at `/` (build with
> `APP_BASE_PATH=/app`). In the self-host build (`APP_BASE_PATH=/`) the Web UI is
> served at `/` and there is no landing page — drop the `/app` prefix accordingly.

---

## Journey 1: First Contact — "What is this and how do I start?"

**Who:** A developer hearing about MCP Moira for the first time. Saw a link in an article/chat.

### User Path

**Step 1: Landing → Understanding the product**

- Lands on the Moira site
- Sees the Hero section: "MCP Moira" + a subtitle with a typing effect
- **User question:** "What is this?"
- **What they see:** A short description plus "Get Started" and "View GitHub" buttons
- **Transition:** Scrolls down or clicks "Get Started"

**Transition check:** ✅ The "Get Started" button scrolls to the #quick-start section

**Step 2: Quick Start → Choosing a client**

- Sees the Quick Start section with tabs: Claude Code, Cursor, Claude Desktop, etc.
- **User question:** "How do I connect this to my tool?"
- **What they see:** Tabs for several MCP clients
- Picks their client (e.g. Claude Code)
- **What they see:** A JSON config to copy plus instructions

**Transition check:** ✅ The tab switches and shows the config for the selected client

**Step 3: Configuring the client**

- Copies the JSON config from Quick Start
- Opens their MCP client's settings (Claude Code / Cursor / etc.)
- Pastes the config
- Restarts the client

**Transition check:** ⚠️ The user leaves the site — the instructions must be complete

**Step 4: First request → OAuth**

- In the MCP client, asks something that uses Moira (e.g. "list workflows")
- The client tries to call `mcp__moira__list`
- **What happens:** The browser opens at /app/oauth/authorize
- **User question:** "Do I need to log in?"

**Transition check:** ✅ The OAuth redirect works, the browser opens

**Step 5: Registration (new user)**

- On /app/oauth/authorize, sees the login form
- No account → clicks "Sign Up"
- Goes to /app/register
- Fills in: email, password, password confirmation
- Checks "I confirm I am not a resident of Russian Federation"
- Clicks "Create Account"

**Transition check:** ✅ After registration → /app/verify-email with a message to check email

**Step 6: Email verification**

- Opens their email
- Finds the message from MCP Moira
- Clicks the verification link
- **What happens:** Redirect to /app/ (Dashboard)

**Transition check:** ✅ After verification the user is logged in and on the Dashboard

**Step 7: Back to the MCP client**

- Returns to the MCP client
- Repeats the request (or the client retries automatically)
- **What happens:** The OAuth flow runs again, but the user is now logged in
- Sees the Consent Screen: "Allow [client] to access..."
- Clicks "Allow"

**Transition check:** ✅ After approval → redirect back to the client with a token

**Step 8: First successful request**

- In the MCP client, sees the result of `mcp__moira__list`
- A list of available workflows

**Transition check:** ✅ The result is returned to the client

**Step 9: Starting the first workflow**

- Picks a workflow from the list
- Calls `mcp__moira__start({ workflowId: "..." })`
- Receives a processId
- Calls `mcp__moira__step({ processId: "..." })`
- Sees the first workflow directive

**Transition check:** ✅ The workflow starts, directives arrive

### Journey 1 Summary

The user went through: Landing → Quick Start → Client config → OAuth → Registration → Email verification → Consent → First request → First workflow

**Possible breakdowns:**

- ❌ If the email never arrives — the user is stuck
- ❌ If the OAuth redirect fails — the user doesn't know what to do
- ❌ If the MCP client is unsupported — there are no instructions

---

## Journey 2: Quick Start — "I already know what this is, I want to start"

**Who:** An experienced developer who knows MCP and wants to connect Moira quickly.

### User Path

**Step 1: Landing → Quick Start**

- Lands on the Moira site
- Scrolls straight to Quick Start (or clicks "Get Started")
- **Skips:** Hero, Features, diagrams

**Step 2: Config → Client**

- Selects the tab for their client
- Copies the config
- Applies it in the client settings

**Step 3: OAuth (account already exists)**

- First request → OAuth redirect
- Logs in (email/password or GitHub/Google)
- Approves consent
- Done

**Step 4: Work**

- `mcp__moira__list` → sees workflows
- `mcp__moira__start` → starts one
- Works

### Journey 2 Summary

The whole path: ~3 minutes if an account exists, ~5 minutes if registration is needed.

**Possible breakdowns:**

- ❌ If Quick Start isn't immediately visible — the user leaves to look for docs
- ❌ If the config is wrong — an error without a clear message

---

## Journey 3: Via GitHub OAuth — "I don't want yet another account"

**Who:** A user who avoids creating new accounts and prefers OAuth.

### User Path

**Steps 1-4:** Same as Journey 1 up to the registration moment

**Step 5: OAuth instead of registration**

- On /app/oauth/authorize, sees the login form
- Sees the "Sign in with GitHub" / "Sign in with Google" buttons
- Clicks "Sign in with GitHub"

**Step 6: GitHub OAuth**

- Redirect to github.com
- Authorizes the MCP Moira application
- Redirect back

**Transition check:** ✅ After GitHub OAuth → straight to the Dashboard (email already verified)

**Step 7: Consent → Work**

- Returns to the MCP client
- OAuth consent screen
- Approve → done

### Journey 3 Summary

Faster than email registration — there is no email verification step.

**Possible breakdowns:**

- ❌ If the GitHub OAuth credentials are not configured — the button is not shown
- ❌ If the user cancels on GitHub — they return without a clear message

---

## Journey 4: Recovery After an Error — "Forgot my password"

**Who:** A user who registered earlier and forgot their password.

### User Path

**Steps 1-3:** Same as Journey 1 up to the login moment

**Step 4: Login attempt with the wrong password**

- Enters email and password
- Error: "Invalid credentials"
- **User question:** "What was the password?"

**Step 5: Forgot Password**

- Clicks "Forgot password?"
- Goes to /app/forgot-password
- Enters their email
- Clicks "Send Reset Link"

**Transition check:** ✅ Message "Check your email"

**Step 6: Email with the reset link**

- Opens their email
- Finds the message
- Clicks the link
- Goes to /app/reset-password

**Step 7: New password**

- Enters the new password twice
- Clicks "Reset Password"
- **What happens:** Redirect to /app/login with a success message

**Transition check:** ✅ After reset they can log in with the new password

**Step 8: Login → OAuth → Work**

- Logs in with the new password
- Returns to the client
- Consent → works

### Journey 4 Summary

Recovery takes ~2-3 minutes.

**Possible breakdowns:**

- ❌ If the reset email never arrives — the user is stuck
- ❌ If the link is expired — it's unclear what to do (need to repeat)

---

## Journey 5: Typo in the Email at Registration — "I mistyped"

**Who:** A user who entered the wrong email during registration.

### User Path

**Steps 1-5:** Same as Journey 1, but with a typo in the email (e.g. user@gmial.com)

**Step 6: The email never arrives**

- Waits for the message
- It doesn't arrive (the email doesn't exist or has a typo)
- **User question:** "Where is the email?"

**Step 7: Attempt to register again**

- Returns to /app/register
- Tries to register with the correct email
- **Problem:** Is the old email already taken? Or can a new account be created?

**Transition check:** ⚠️ Depends on the implementation — the behavior needs to be verified

**Possible outcomes:**

1. A new account can be created with the correct email — ✅ OK
2. The system says "email already exists" for the typo'd one — ❌ Dead end
3. There is a "Resend verification" feature — ✅ But it won't help if the email is wrong

### Journey 5 Summary

**Critical breakdown:** If the user mistyped the email and cannot fix it.

**Fix:** Need the ability to change the email before verification, OR automatic deletion of unverified accounts.

---

## Journey 6: Working Through the Web UI — "I want to browse workflows in the browser"

**Who:** A user who wants to explore workflows through the web interface rather than an MCP client.

### User Path

**Step 1: Direct visit to /app/**

- Enters ${MOIRA_HOST}/app/ in the browser
- **What happens:** Redirect to /app/login (not logged in)

**Step 2: Login**

- Logs in (email/password or OAuth)
- **What happens:** Redirect to /app/ (Dashboard)

**Step 3: Dashboard**

- Sees:
  - A Quick Start card with the config for an MCP client
  - Stats: number of workflows, executions
  - Recent Workflows
  - Recent Executions

**Transition check:** ✅ The Dashboard shows useful information

**Step 4: Workflows**

- Clicks "Workflows" in the sidebar
- Goes to /app/workflows
- Sees the list of available workflows (public + their own private)

**Step 5: Workflow Details**

- Clicks a workflow
- Goes to /app/workflows/:id
- Sees:
  - A graph visualization (nodes + connections)
  - Details of the selected node in the sidebar
  - Buttons: Run, Edit, Delete

**Transition check:** ✅ The graph renders, nodes are clickable

**Step 6: Executions**

- Clicks "Executions" in the sidebar
- Sees the list of their executions
- Filters: status, workflow
- Sorting: by date

**Step 7: Execution Details**

- Clicks an execution
- Goes to /app/executions/:id
- Sees:
  - The graph with the current node highlighted
  - A Context editor (JSON)
  - Status, errors

**Transition check:** ✅ Execution progress can be tracked

### Journey 6 Summary

The Web UI lets users explore workflows and monitor executions without an MCP client.

**Possible breakdowns:**

- ❌ A workflow cannot be created through the Web UI (only via MCP tools or JSON upload)
- ❌ A workflow cannot be started through the Web UI (only via an MCP client)

---

## Journey 7: Revoking Access — "I want to disconnect a client"

**Who:** A user who wants to revoke an MCP client's access.

### User Path

**Step 1: Settings**

- Goes to /app/settings
- Sees the tabs: Profile, Security, OAuth, Sessions

**Step 2: OAuth Consents**

- Clicks the "OAuth" tab
- Sees the list of clients they granted access to
- Each client shows: client_id, scopes, consent date

**Step 3: Revoke**

- Clicks "Revoke" next to a client
- Confirms the action
- **What happens:** The consent is removed

**Transition check:** ✅ After revocation the client gets a 401 on its next request

**Step 4: The client loses access**

- In the MCP client, the next request returns an error
- The OAuth flow must be completed again

### Journey 7 Summary

The user can control which clients have access.

---

## Journey 8: Administrator — "I need to block a user"

**Who:** A system administrator.

### User Path

**Step 1: Admin Panel**

- Goes to /app/admin
- Sees a Dashboard with statistics: users, workflows, executions

**Step 2: User Management**

- Clicks "Users" in the admin menu
- Sees the list of users
- Search by email/name

**Step 3: Block User**

- Finds the user
- Clicks them → /app/admin/users/:id
- Sees details: email, role, status, created, executions
- Clicks "Block User"

**Transition check:** ✅ The user is blocked

**Step 4: Blocked User Experience**

- The blocked user tries to log in
- Sees: "Your account has been blocked"
- The MCP tokens stop working

### Journey 8 Summary

The administrator can manage users.

---

## Summary of Transitions and Breakdowns

| Journey            | Transitions | Critical breakdowns            |
| ------------------ | ----------- | ------------------------------ |
| 1. First contact   | 9           | Email delivery, OAuth redirect |
| 2. Quick start     | 4           | Quick Start visibility         |
| 3. GitHub OAuth    | 7           | OAuth credentials config       |
| 4. Forgot password | 8           | Reset email delivery           |
| 5. Email typo      | 7           | **No recovery path**           |
| 6. Web UI          | 7           | Cannot create/start a workflow |
| 7. Revoke access   | 4           | None                           |
| 8. Admin block     | 4           | None                           |

### Critical Issues to Fix

1. **Journey 5 — Email typo:** No way to fix the email before verification
2. **Email delivery:** A critical dependency on an external service
3. **Web UI limitations:** Cannot fully work without an MCP client

---

## E2E Test Coverage

| Journey            | Coverage                                                             |
| ------------------ | -------------------------------------------------------------------- |
| 1. First contact   | Partial: auth flow covered, landing page i18n covered                |
| 2. Quick start     | Partial: OAuth flow covered                                          |
| 3. GitHub OAuth    | ⚠️ No dedicated GitHub OAuth E2E spec (manual QA — needs real creds) |
| 4. Forgot password | ✅ forgot-password.spec.ts                                           |
| 5. Email typo      | ❌ Not covered (edge case)                                           |
| 6. Web UI          | ✅ dashboard.spec.ts, workflow-\*.spec.ts, executions-\*.spec.ts     |
| 7. Revoke access   | ✅ user-oauth-sessions.spec.ts                                       |
| 8. Admin block     | ✅ user-blocking.spec.ts                                             |

### Tests Covering Journey Transitions

**Landing → Auth:**

- `i18n-stage1-verification.spec.ts` — landing/UI renders with i18n
- `web-registration.spec.ts` — registration + email verification
- `web-login.spec.ts` — login

**MCP OAuth Flow:**

- `inspector-oauth-registration.spec.ts` — registration via OAuth through the MCP Inspector
- `inspector-mcp-tools.spec.ts` — MCP tool calls through the Inspector
- `oauth-consent.spec.ts` — consent screen

**Dashboard/Workflows/Executions:**

- `dashboard.spec.ts` — dashboard loads
- `workflow-visibility.spec.ts` — public/private workflows
- `workflow-canvas-controls.spec.ts` — workflow visualization
- `executions-page.spec.ts` — executions list
- `executions-navigation.spec.ts` — execution details

**Settings:**

- `user-profile.spec.ts` — profile settings
- `settings-page.spec.ts` — settings tabs
- `user-oauth-sessions.spec.ts` — OAuth consents, sessions

**Admin:**

- `admin-panel.spec.ts` — admin access
- `admin-user-security.spec.ts` — user management
- `user-blocking.spec.ts` — block/unblock users

---

## QA Checklist (Manual Testing Required)

Scenarios that can't be automated in E2E:

### P0 (Must test before release)

1. **Google OAuth Flow**
   - Requires real Google credentials
   - Steps: Login → Sign in with Google → Approve → Dashboard

2. **Real MCP Client Integration**
   - Requires an installed Claude Code / Cursor
   - Steps: Copy config → Apply → First request → OAuth → Consent → Tool response

3. **Email Delivery**
   - Requires a real email provider
   - Steps: Register → Check inbox → Click verification → Dashboard

### P1 (Should test)

4. **Cross-browser OAuth**
   - Safari, Firefox, Edge
   - Steps: Full OAuth flow in each browser

5. **Mobile responsive**
   - Landing page, Login, Dashboard on mobile

### P2 (Nice to have)

6. **Slow network**
   - OAuth redirect with high latency

7. **Concurrent sessions**
   - Login from multiple devices
