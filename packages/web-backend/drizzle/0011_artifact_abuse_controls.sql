-- Artifact abuse controls: viewer reports + admin takedown
ALTER TABLE `artifact` ADD COLUMN `reportCount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `artifact` ADD COLUMN `lastReportedAt` integer;--> statement-breakpoint
ALTER TABLE `artifact` ADD COLUMN `takenDown` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `artifact` ADD COLUMN `takenDownAt` integer;--> statement-breakpoint
ALTER TABLE `artifact` ADD COLUMN `takenDownBy` text REFERENCES `user`(`id`);--> statement-breakpoint
ALTER TABLE `artifact` ADD COLUMN `takenDownReason` text;--> statement-breakpoint
CREATE INDEX `artifact_taken_down_idx` ON `artifact` (`takenDown`);--> statement-breakpoint
CREATE INDEX `artifact_report_count_idx` ON `artifact` (`reportCount`);
