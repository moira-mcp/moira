# QA Checklist - MCP Moira

Manual testing checklist for scenarios that cannot be automated in E2E tests.

## How to Use

1. Before release, go through each section
2. Mark items as PASS/FAIL
3. Document any issues found
4. All P0 items must PASS before release

---

## 1. Google OAuth Login

**Priority**: P0 (Critical Path)
**Reason**: Requires real Google credentials, cannot be mocked in CI

### Prerequisites

- Google OAuth credentials configured in environment
- Test Google account available

### Steps

1. Open /app/login
2. Click "Sign in with Google"
3. Complete Google OAuth flow
4. Verify redirect back to application

### Expected Results

- [ ] Google OAuth button visible on login page
- [ ] Clicking opens Google consent screen
- [ ] After approval, redirect to /app/ (dashboard)
- [ ] User email from Google displayed in sidebar
- [ ] Session cookie created

### Edge Cases

- [ ] Cancel OAuth flow → returns to login page without error
- [ ] Google account without email access → error message displayed
- [ ] Existing user with same email → accounts linked correctly

---

## 2. MCP Client Integration (Real Clients)

**Priority**: P1 (Important)
**Reason**: Requires actual MCP client installation and configuration

### Prerequisites

- Claude Code or Cursor installed
- MCP server URL configured

### Test with Claude Code

#### Steps

1. Configure MCP server in Claude Code:
   ```bash
   claude mcp add --transport http moira https://${MOIRA_HOST}/mcp
   ```
   Or add to `~/.config/claude/mcp.json`:
   ```json
   {
     "mcpServers": {
       "moira": {
         "url": "https://${MOIRA_HOST}/mcp"
       }
     }
   }
   ```
2. Start new conversation
3. Use any MCP tool (e.g., `mcp__moira__list`)

#### Expected Results

- [ ] Browser opens for OAuth authorization
- [ ] After login, consent screen shows
- [ ] After approval, MCP tools work in Claude Code
- [ ] Tool results return correctly

### Test with Cursor

#### Steps

1. Configure MCP server in Cursor settings
2. Use MCP tool in conversation

#### Expected Results

- [ ] OAuth flow completes
- [ ] Tools accessible in Cursor

---

## 3. Email Delivery

**Priority**: P1 (Important)
**Reason**: Depends on email provider configuration

### Prerequisites

- Email service configured (Resend, SMTP)
- Test email account accessible

### Registration Email

1. Register new account with test email
2. Check inbox for verification email

#### Expected Results

- [ ] Email arrives within 2 minutes
- [ ] Subject: "Verify your email"
- [ ] Verification link works
- [ ] Link redirects to /app/ after verification

### Password Reset Email

1. Request password reset
2. Check inbox for reset email

#### Expected Results

- [ ] Email arrives within 2 minutes
- [ ] Subject contains "reset" or "password"
- [ ] Reset link opens /app/reset-password
- [ ] Can set new password
- [ ] Old password no longer works

---

## 4. Mobile Responsiveness

**Priority**: P2 (Nice to have)
**Reason**: Visual verification needed

### Landing Page

- [ ] Hero section readable on mobile (320px width)
- [ ] Quick Start tabs scrollable/accessible
- [ ] Navigation menu works (hamburger)
- [ ] All CTAs clickable (44px minimum touch target)

### Web Application

- [ ] Sidebar collapses to icons on mobile
- [ ] Dashboard cards stack vertically
- [ ] Tables horizontally scrollable
- [ ] Forms usable on mobile keyboard

---

## 5. Cross-Browser Compatibility

**Priority**: P2 (Nice to have)
**Reason**: E2E tests run only on Chromium

### Browsers to Test

- [ ] Safari (macOS)
- [ ] Firefox
- [ ] Chrome
- [ ] Edge

### Critical Flows per Browser

- [ ] Login flow works
- [ ] OAuth consent works
- [ ] Dashboard loads
- [ ] Workflow visualization renders

---

## 6. Performance Under Load

**Priority**: P2 (Nice to have)
**Reason**: Cannot be automated without load testing infrastructure

### Scenarios

- [ ] Dashboard with 100+ workflows loads in <3s
- [ ] Executions list with 1000+ items paginates correctly
- [ ] Workflow visualization with 50+ nodes renders
- [ ] Concurrent MCP requests (5+) don't timeout

---

## 7. Session Management Edge Cases

**Priority**: P1 (Important)
**Reason**: Requires manual state manipulation

### Multi-Tab Behavior

1. Login in Tab 1
2. Open Tab 2 with same session
3. Logout in Tab 1

#### Expected Results

- [ ] Tab 2 redirects to login on next action
- [ ] No stale data shown

### Session Expiration

1. Login
2. Wait for session expiration (or manually delete cookie)
3. Try to access protected page

#### Expected Results

- [ ] Redirect to login
- [ ] Clear error message (if any)
- [ ] Can login again successfully

---

## 8. Admin Panel Security

**Priority**: P0 (Critical)
**Reason**: Security verification requires manual testing

### Access Control

1. Login as regular user
2. Try to access /app/admin/\*

#### Expected Results

- [ ] 403 Forbidden or redirect
- [ ] No admin data visible
- [ ] API returns appropriate error

### User Blocking

1. Admin blocks user
2. Blocked user tries to login

#### Expected Results

- [ ] Login fails with "blocked" message
- [ ] Existing sessions invalidated
- [ ] MCP tokens revoked

---

## Summary

| Category           | P0 Items | P1 Items | P2 Items |
| ------------------ | -------- | -------- | -------- |
| Google OAuth       | 1        | -        | -        |
| MCP Integration    | -        | 2        | -        |
| Email Delivery     | -        | 2        | -        |
| Mobile             | -        | -        | 2        |
| Cross-Browser      | -        | -        | 4        |
| Performance        | -        | -        | 4        |
| Session Management | -        | 2        | -        |
| Admin Security     | 2        | -        | -        |
| **TOTAL**          | **3**    | **6**    | **10**   |

**Release Criteria**: All P0 items must PASS. P1 items should PASS (exceptions documented).
