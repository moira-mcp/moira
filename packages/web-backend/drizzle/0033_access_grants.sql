-- Generalizes workflow-only sharing into grants that address any resource, and introduces the group
-- model access decisions are written against.
--
-- The first statement recreates `workflowAccess` when it is absent, so this migration is safe to
-- replay on a database where it already ran; on a real upgrade the table exists and the statement
-- does nothing.
CREATE TABLE IF NOT EXISTS `workflowAccess` (
	`id` text PRIMARY KEY NOT NULL,
	`workflowId` text NOT NULL,
	`userId` text NOT NULL,
	`grantedBy` text NOT NULL,
	`inviteId` text,
	`grantedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `principalGroup` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`createdBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `principalGroupMember` (
	`groupId` text NOT NULL,
	`userId` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`addedAt` integer NOT NULL,
	PRIMARY KEY(`groupId`, `userId`),
	FOREIGN KEY (`groupId`) REFERENCES `principalGroup`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `accessGrant` (
	`id` text PRIMARY KEY NOT NULL,
	`resourceType` text NOT NULL,
	`resourceId` text NOT NULL,
	`userId` text,
	`groupId` text,
	`level` text DEFAULT 'use' NOT NULL,
	`grantedBy` text NOT NULL,
	`inviteId` text,
	`grantedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`groupId`) REFERENCES `principalGroup`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grantedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviteId`) REFERENCES `workflowInvite`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `access_grant_user_resource_idx` ON `accessGrant` (`resourceType`,`resourceId`,`userId`) WHERE `userId` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `access_grant_group_resource_idx` ON `accessGrant` (`resourceType`,`resourceId`,`groupId`) WHERE `groupId` IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `access_grant_subject_idx` ON `accessGrant` (`userId`,`resourceType`);--> statement-breakpoint
INSERT OR IGNORE INTO `accessGrant` (`id`, `resourceType`, `resourceId`, `userId`, `groupId`, `level`, `grantedBy`, `inviteId`, `grantedAt`)
SELECT `id`, 'workflow', `workflowId`, `userId`, NULL, 'use', `grantedBy`, `inviteId`, `grantedAt` FROM `workflowAccess`;--> statement-breakpoint
DROP TABLE `workflowAccess`;
