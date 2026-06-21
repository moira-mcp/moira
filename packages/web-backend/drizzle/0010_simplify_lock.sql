-- Simplify lock architecture: remove rejection/expiration, make pin NOT NULL
-- Step 1: Drop unused columns (SQLite 3.35+ supports DROP COLUMN)
ALTER TABLE `executionLock` DROP COLUMN `pinHash`;--> statement-breakpoint
ALTER TABLE `executionLock` DROP COLUMN `rejectionReason`;--> statement-breakpoint
ALTER TABLE `executionLock` DROP COLUMN `expiresAt`;--> statement-breakpoint

-- Step 2: Recreate table to make pin NOT NULL (SQLite can't ALTER COLUMN)
-- Save data, drop table, create with new schema, restore data
CREATE TABLE `executionLock_new` (
	`id` text PRIMARY KEY NOT NULL,
	`executionId` text NOT NULL,
	`nodeId` text NOT NULL,
	`reason` text NOT NULL,
	`lockedBy` text NOT NULL,
	`pin` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`createdAt` integer NOT NULL,
	`unlockedAt` integer,
	FOREIGN KEY (`executionId`) REFERENCES `workflowExecution`(`executionId`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lockedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `executionLock_new` SELECT `id`, `executionId`, `nodeId`, `reason`, `lockedBy`, COALESCE(`pin`, 'migrated'), `status`, `createdAt`, `unlockedAt` FROM `executionLock`;--> statement-breakpoint
DROP TABLE `executionLock`;--> statement-breakpoint
ALTER TABLE `executionLock_new` RENAME TO `executionLock`;--> statement-breakpoint
CREATE INDEX `execution_lock_execution_idx` ON `executionLock` (`executionId`);--> statement-breakpoint
CREATE INDEX `execution_lock_status_idx` ON `executionLock` (`status`);
