CREATE TABLE `executionLock` (
	`id` text PRIMARY KEY NOT NULL,
	`executionId` text NOT NULL,
	`nodeId` text NOT NULL,
	`reason` text NOT NULL,
	`lockedBy` text NOT NULL,
	`pinHash` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`rejectionReason` text,
	`createdAt` integer NOT NULL,
	`expiresAt` integer,
	`unlockedAt` integer,
	FOREIGN KEY (`executionId`) REFERENCES `workflowExecution`(`executionId`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lockedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `execution_lock_execution_idx` ON `executionLock` (`executionId`);--> statement-breakpoint
CREATE INDEX `execution_lock_status_idx` ON `executionLock` (`status`);