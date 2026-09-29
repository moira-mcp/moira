CREATE TABLE `executionNotification` (
	`id` text PRIMARY KEY NOT NULL,
	`executionId` text NOT NULL,
	`userId` text NOT NULL,
	`waitKey` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`notBefore` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`sentAt` integer,
	`deliveryStatus` text,
	`deliveredChannels` text,
	FOREIGN KEY (`executionId`) REFERENCES `workflowExecution`(`executionId`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_notification_wait_idx` ON `executionNotification` (`executionId`,`waitKey`,`kind`);--> statement-breakpoint
CREATE INDEX `execution_notification_pending_idx` ON `executionNotification` (`state`,`notBefore`);
