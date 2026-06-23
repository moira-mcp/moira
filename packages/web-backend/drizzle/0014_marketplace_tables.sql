CREATE TABLE `libraryEntry` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`workflowId` text NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`listingId` text,
	`addedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflowId`) REFERENCES `workflow`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`listingId`) REFERENCES `marketplaceListing`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_entry_user_workflow_idx` ON `libraryEntry` (`userId`,`workflowId`);--> statement-breakpoint
CREATE INDEX `library_entry_user_idx` ON `libraryEntry` (`userId`);--> statement-breakpoint
CREATE INDEX `library_entry_listing_idx` ON `libraryEntry` (`listingId`);--> statement-breakpoint
CREATE TABLE `marketplaceEntitlement` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`listingId` text NOT NULL,
	`source` text NOT NULL,
	`grantedAt` integer NOT NULL,
	`expiresAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`listingId`) REFERENCES `marketplaceListing`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `marketplace_entitlement_user_listing_idx` ON `marketplaceEntitlement` (`userId`,`listingId`);--> statement-breakpoint
CREATE INDEX `marketplace_entitlement_user_idx` ON `marketplaceEntitlement` (`userId`);--> statement-breakpoint
CREATE TABLE `marketplaceEvent` (
	`id` text PRIMARY KEY NOT NULL,
	`listingId` text NOT NULL,
	`userId` text,
	`type` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`listingId`) REFERENCES `marketplaceListing`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `marketplace_event_listing_at_idx` ON `marketplaceEvent` (`listingId`,`at`);--> statement-breakpoint
CREATE INDEX `marketplace_event_type_at_idx` ON `marketplaceEvent` (`type`,`at`);--> statement-breakpoint
CREATE TABLE `marketplaceListing` (
	`id` text PRIMARY KEY NOT NULL,
	`workflowId` text NOT NULL,
	`publishedBy` text NOT NULL,
	`status` text DEFAULT 'listed' NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`category` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`verifyCandidate` integer DEFAULT false NOT NULL,
	`verifiedAt` integer,
	`verifiedBy` text,
	`featured` integer DEFAULT false NOT NULL,
	`ratingAvg` real DEFAULT 0 NOT NULL,
	`ratingCount` integer DEFAULT 0 NOT NULL,
	`installCount` integer DEFAULT 0 NOT NULL,
	`startCount` integer DEFAULT 0 NOT NULL,
	`viewCount` integer DEFAULT 0 NOT NULL,
	`isPaid` integer DEFAULT false NOT NULL,
	`price` integer,
	`currency` text,
	`origin` text DEFAULT 'local' NOT NULL,
	`importedFrom` text,
	`importedAt` integer,
	`publishedAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`workflowId`) REFERENCES `workflow`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`publishedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`verifiedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `marketplace_listing_workflow_idx` ON `marketplaceListing` (`workflowId`);--> statement-breakpoint
CREATE INDEX `marketplace_listing_status_idx` ON `marketplaceListing` (`status`);--> statement-breakpoint
CREATE INDEX `marketplace_listing_category_idx` ON `marketplaceListing` (`category`);--> statement-breakpoint
CREATE INDEX `marketplace_listing_verified_idx` ON `marketplaceListing` (`verified`);--> statement-breakpoint
CREATE INDEX `marketplace_listing_featured_idx` ON `marketplaceListing` (`featured`);--> statement-breakpoint
CREATE INDEX `marketplace_listing_rating_idx` ON `marketplaceListing` (`ratingAvg`);--> statement-breakpoint
CREATE INDEX `marketplace_listing_published_by_idx` ON `marketplaceListing` (`publishedBy`);--> statement-breakpoint
CREATE TABLE `marketplaceReview` (
	`id` text PRIMARY KEY NOT NULL,
	`listingId` text NOT NULL,
	`userId` text NOT NULL,
	`stars` integer NOT NULL,
	`reviewText` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`listingId`) REFERENCES `marketplaceListing`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "marketplace_review_stars_check" CHECK("marketplaceReview"."stars" between 1 and 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `marketplace_review_listing_user_idx` ON `marketplaceReview` (`listingId`,`userId`);--> statement-breakpoint
CREATE INDEX `marketplace_review_listing_idx` ON `marketplaceReview` (`listingId`);