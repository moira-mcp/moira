ALTER TABLE `user` ADD `approvedAt` text;
--> statement-breakpoint
UPDATE `user`
SET `approvedAt` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `approvedAt` IS NULL;
