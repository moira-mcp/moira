CREATE TABLE `workflowInvite` (
	`id` text PRIMARY KEY NOT NULL,
	`workflowId` text NOT NULL,
	`createdBy` text NOT NULL,
	`token` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`usedAt` integer,
	`usedBy` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`workflowId`) REFERENCES `workflow`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`createdBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`usedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflowInvite_token_unique` ON `workflowInvite` (`token`);--> statement-breakpoint
CREATE TABLE `workflowAccess` (
	`id` text PRIMARY KEY NOT NULL,
	`workflowId` text NOT NULL,
	`userId` text NOT NULL,
	`grantedBy` text NOT NULL,
	`inviteId` text,
	`grantedAt` integer NOT NULL,
	FOREIGN KEY (`workflowId`) REFERENCES `workflow`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grantedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviteId`) REFERENCES `workflowInvite`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_access_user_workflow_idx` ON `workflowAccess` (`workflowId`,`userId`);