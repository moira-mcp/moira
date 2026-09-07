CREATE TABLE `communication_attachment_grant` (
	`token_digest` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`correlation_id` text NOT NULL,
	`audience` text NOT NULL,
	`purpose` text NOT NULL,
	`message` text NOT NULL,
	`format` text NOT NULL,
	`silent` integer DEFAULT false NOT NULL,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`declared_size` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`claim_id` text,
	`claimed_at` integer,
	`completed_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `communication_grant_user_state_expiry_idx` ON `communication_attachment_grant` (`user_id`,`state`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `communication_grant_state_expiry_idx` ON `communication_attachment_grant` (`state`,`expires_at`);
