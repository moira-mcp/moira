-- Self-host: configurable note quotas + execution retention
-- Adds admin-configurable global settings so a self-host operator can tune limits
-- (previously hardcoded) and bound unbounded execution growth.

INSERT OR IGNORE INTO globalSetting (key, value, type, label, description, category, sortOrder, updatedAt)
VALUES
  ('notes.max_note_size_kb', '100', 'number', 'Max Note Size (KB)', 'Maximum size of a single note in kilobytes', 'notes', 1, unixepoch() * 1000),
  ('notes.max_user_total_kb', '1024', 'number', 'Max Notes Total Per User (KB)', 'Maximum total notes storage per user in kilobytes', 'notes', 2, unixepoch() * 1000),
  ('notes.max_versions', '50', 'number', 'Max Versions Per Note', 'Maximum retained versions per note', 'notes', 3, unixepoch() * 1000),
  ('executions.retention_days', '0', 'number', 'Execution Retention (days)', 'Delete completed executions older than this many days. 0 disables cleanup (keep forever).', 'executions', 1, unixepoch() * 1000);
