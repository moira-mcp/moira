-- Moves note content into the shared revision store that notes, global settings and playbooks all
-- use, and retires the per-note history table.
--
-- The first statement recreates `noteVersion` when it is absent. That is not an upgrade step: it
-- makes this migration safe to replay on a database where it already ran, which the migration tests
-- do when they rewind the journal to an earlier migration. On a real upgrade the table exists and
-- the statement does nothing.
CREATE TABLE IF NOT EXISTS `noteVersion` (
	`id` text PRIMARY KEY NOT NULL,
	`noteId` text NOT NULL,
	`version` integer NOT NULL,
	`value` text NOT NULL,
	`size` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `entityRevision` (
	`id` text PRIMARY KEY NOT NULL,
	`entityType` text NOT NULL,
	`entityId` text NOT NULL,
	`revision` integer NOT NULL,
	`content` text,
	`size` integer NOT NULL,
	`authorId` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`authorId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `entity_revision_idx` ON `entityRevision` (`entityType`,`entityId`,`revision`);--> statement-breakpoint
INSERT OR IGNORE INTO `entityRevision` (`id`, `entityType`, `entityId`, `revision`, `content`, `size`, `authorId`, `createdAt`)
SELECT `noteVersion`.`id`, 'note', `noteVersion`.`noteId`, `noteVersion`.`version`, `noteVersion`.`value`, `noteVersion`.`size`, `note`.`userId`, `noteVersion`.`createdAt`
FROM `noteVersion` JOIN `note` ON `note`.`id` = `noteVersion`.`noteId`;--> statement-breakpoint
DROP TABLE `noteVersion`;
