/**
 * Admin audit and email logs for a user whose account can no longer be found: the email is `null`,
 * never an English "Unknown", so each admin view words the gap in the reader's language.
 *
 * The rows are written straight into the container database with the sqlite3 CLI, which does not
 * enforce foreign keys; that is the one way to reproduce a log entry whose user lookup fails.
 */

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";
import { formatSessionCookie, getAdminSessionCookie } from "../utils/mcp-auth.js";
import { execSqliteInDocker } from "../utils/docker-command.js";

const BASE_URL = getTestBaseUrl();
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ghostUserId = `ghost-user-${stamp}`;
const auditId = `ghost-audit-${stamp}`;
const emailId = `ghost-email-${stamp}`;

let adminCookie: string;

beforeAll(async () => {
  adminCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));
  const now = Date.now();
  execSqliteInDocker(
    `INSERT INTO auditLog (id, userId, action, resource, source, createdAt)
     VALUES ('${auditId}', '${ghostUserId}', 'test:missing_user', 'test', 'api', ${now});`,
  );
  execSqliteInDocker(
    `INSERT INTO emailLog (id, userId, type, "to", subject, messageId, status, createdAt)
     VALUES ('${emailId}', '${ghostUserId}', 'notification', 'gone@example.test', 'Probe',
             'probe-${stamp}', 'sent', '${new Date(now).toISOString()}');`,
  );
});

afterAll(() => {
  execSqliteInDocker(`DELETE FROM auditLog WHERE id = '${auditId}';`);
  execSqliteInDocker(`DELETE FROM emailLog WHERE id = '${emailId}';`);
});

describe("admin logs for a user who cannot be found", () => {
  test.each([
    ["the audit log", `/api/admin/audit-log?userId=${ghostUserId}`, auditId],
    ["the email log", `/api/admin/emails?userId=${ghostUserId}`, emailId],
  ])(
    "%s reports the missing email as null, not as an English placeholder",
    async (_label, url, id) => {
      const response = await fetch(`${BASE_URL}${url}`, { headers: { Cookie: adminCookie } });
      expect(response.status).toBe(200);
      const text = await response.text();
      const body = JSON.parse(text) as { data: unknown };
      const rows = (
        Array.isArray(body.data)
          ? body.data
          : ((body.data as { entries?: unknown[] }).entries ?? [])
      ) as Array<Record<string, unknown>>;
      const row = rows.find((entry) => entry.id === id);

      expect(row).toBeDefined();
      expect(row?.userId).toBe(ghostUserId);
      expect(row?.userEmail).toBeNull();
      expect(text).not.toContain('"Unknown"');
    },
  );
});
