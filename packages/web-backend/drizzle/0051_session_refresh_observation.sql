-- Null preserves unknown provenance for initial and historical sessions.
ALTER TABLE `session` ADD `refreshedAt` text;--> statement-breakpoint
DROP INDEX `session_user_expiry_activity_idx`;--> statement-breakpoint
DROP INDEX `session_activity_expiry_idx`;--> statement-breakpoint
CREATE INDEX `session_user_expiry_activity_idx` ON `session` (`userId`,CASE WHEN expiresAt GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][ T][0-9][0-9]:[0-9][0-9]:[0-9][0-9]*' THEN cast(unixepoch(expiresAt, 'subsec')*1000 AS integer) END,CASE WHEN refreshedAt GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][ T][0-9][0-9]:[0-9][0-9]:[0-9][0-9]*' THEN cast(unixepoch(refreshedAt, 'subsec')*1000 AS integer) END);--> statement-breakpoint
CREATE INDEX `session_activity_expiry_idx` ON `session` (CASE WHEN refreshedAt GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][ T][0-9][0-9]:[0-9][0-9]:[0-9][0-9]*' THEN cast(unixepoch(refreshedAt, 'subsec')*1000 AS integer) END,CASE WHEN expiresAt GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][ T][0-9][0-9]:[0-9][0-9]:[0-9][0-9]*' THEN cast(unixepoch(expiresAt, 'subsec')*1000 AS integer) END);
