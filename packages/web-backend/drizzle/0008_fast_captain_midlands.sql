CREATE TABLE `apiToken` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tokenPrefix` text NOT NULL,
	`tokenHash` text NOT NULL,
	`userId` text NOT NULL,
	`scopes` text,
	`expiresAt` text,
	`lastUsedAt` text,
	`createdAt` text NOT NULL,
	`revokedAt` text,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apiToken_tokenHash_idx` ON `apiToken` (`tokenHash`);--> statement-breakpoint
CREATE INDEX `apiToken_userId_idx` ON `apiToken` (`userId`);--> statement-breakpoint
CREATE INDEX `apiToken_expiresAt_idx` ON `apiToken` (`expiresAt`);