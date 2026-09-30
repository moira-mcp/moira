CREATE TABLE `executionChange` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`executionId` text NOT NULL,
	`userId` text NOT NULL,
	`kind` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `execution_change_user_seq_idx` ON `executionChange` (`userId`,`seq`);--> statement-breakpoint
CREATE INDEX `execution_change_at_idx` ON `executionChange` (`at`);
