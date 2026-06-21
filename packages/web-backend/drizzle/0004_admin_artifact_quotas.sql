-- Step 6: Admin Panel and Quota Management
-- Adds per-user artifact quota overrides and global settings for artifacts

-- Add per-user artifact quota override fields to user table
ALTER TABLE user ADD COLUMN artifactQuotaMb INTEGER;
--> statement-breakpoint
ALTER TABLE user ADD COLUMN artifactMaxFiles INTEGER;
--> statement-breakpoint
-- Insert global settings for artifact quotas
INSERT OR IGNORE INTO globalSetting (key, value, type, label, description, category, sortOrder, updatedAt)
VALUES
  ('artifacts.default_quota_mb', '100', 'number', 'Default Storage Quota (MB)', 'Maximum total storage per user in megabytes', 'artifacts', 1, unixepoch() * 1000),
  ('artifacts.default_ttl_days', '30', 'number', 'Default TTL (days)', 'Default time-to-live for artifacts in days', 'artifacts', 2, unixepoch() * 1000),
  ('artifacts.max_file_size_mb', '5', 'number', 'Max File Size (MB)', 'Maximum size per artifact in megabytes', 'artifacts', 3, unixepoch() * 1000),
  ('artifacts.default_max_files', '50', 'number', 'Default Max Files', 'Maximum number of artifacts per user', 'artifacts', 4, unixepoch() * 1000);
