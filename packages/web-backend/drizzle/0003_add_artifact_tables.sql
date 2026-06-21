CREATE TABLE `artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`uuid` text NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`size` integer NOT NULL,
	`mimeType` text DEFAULT 'text/html' NOT NULL,
	`executionId` text,
	`expiresAt` integer NOT NULL,
	`deleted` integer DEFAULT false,
	`deletedAt` integer,
	`deletedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`executionId`) REFERENCES `workflowExecution`(`executionId`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deletedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_uuid_unique` ON `artifact` (`uuid`);--> statement-breakpoint
CREATE TABLE `artifactToken` (
	`token` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`type` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`used` integer DEFAULT false,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
