CREATE TABLE `note` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`key` text NOT NULL,
	`tags` text,
	`size` integer DEFAULT 0 NOT NULL,
	`currentVersion` integer DEFAULT 1 NOT NULL,
	`deleted` integer DEFAULT false,
	`deletedAt` integer,
	`deletedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deletedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `note_user_key_idx` ON `note` (`userId`,`key`);--> statement-breakpoint
CREATE TABLE `noteVersion` (
	`id` text PRIMARY KEY NOT NULL,
	`noteId` text NOT NULL,
	`version` integer NOT NULL,
	`value` text NOT NULL,
	`size` integer NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`noteId`) REFERENCES `note`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `note_version_idx` ON `noteVersion` (`noteId`,`version`);--> statement-breakpoint
ALTER TABLE `settingDefinition` ADD `protected` integer DEFAULT false;