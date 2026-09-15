CREATE TABLE IF NOT EXISTS `playbook` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`visibility` text DEFAULT 'private' NOT NULL,
	`currentRevision` integer DEFAULT 1 NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `playbook_owner_slug_idx` ON `playbook` (`userId`,`slug`);
