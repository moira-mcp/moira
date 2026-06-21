CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` text,
	`refreshTokenExpiresAt` text,
	`scope` text,
	`password` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `auditLog` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text,
	`action` text NOT NULL,
	`resource` text,
	`resourceId` text,
	`source` text,
	`ip` text,
	`country` text,
	`userAgent` text,
	`metadata` text,
	`changes` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `emailLog` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`type` text NOT NULL,
	`to` text NOT NULL,
	`subject` text NOT NULL,
	`messageId` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `globalSetting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`type` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`category` text DEFAULT 'general' NOT NULL,
	`sortOrder` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL,
	`updatedBy` text,
	FOREIGN KEY (`updatedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `oauthAccessToken` (
	`id` text PRIMARY KEY NOT NULL,
	`accessToken` text NOT NULL,
	`refreshToken` text,
	`accessTokenExpiresAt` text NOT NULL,
	`refreshTokenExpiresAt` text,
	`clientId` text NOT NULL,
	`userId` text NOT NULL,
	`scopes` text NOT NULL,
	`toolsVersion` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauthApplication` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`metadata` text,
	`clientId` text NOT NULL,
	`clientSecret` text,
	`redirectURLs` text NOT NULL,
	`type` text NOT NULL,
	`disabled` integer DEFAULT false,
	`userId` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthApplication_clientId_unique` ON `oauthApplication` (`clientId`);--> statement-breakpoint
CREATE TABLE `oauthConsent` (
	`id` text PRIMARY KEY NOT NULL,
	`clientId` text NOT NULL,
	`userId` text NOT NULL,
	`scopes` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`consentGiven` integer DEFAULT false,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` text NOT NULL,
	`token` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`country` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `settingDefinition` (
	`key` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`category` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`defaultValue` text,
	`required` integer DEFAULT false,
	`validation` text,
	`adminOnly` integer DEFAULT false,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`handle` text NOT NULL,
	`emailVerified` integer DEFAULT false,
	`image` text,
	`isAdmin` integer DEFAULT false,
	`blocked` integer DEFAULT false,
	`blockedAt` text,
	`blockedReason` text,
	`blockedBy` text,
	`passwordResetRequired` integer DEFAULT false,
	`passwordResetRequestedAt` text,
	`passwordResetRequestedBy` text,
	`acceptedTermsAt` text,
	`acceptedNotRussianResidentAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`blockedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`passwordResetRequestedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_handle_unique` ON `user` (`handle`);--> statement-breakpoint
CREATE TABLE `userSettingValue` (
	`userId` text NOT NULL,
	`settingKey` text NOT NULL,
	`value` text NOT NULL,
	`encrypted` integer DEFAULT false,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `settingKey`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`settingKey`) REFERENCES `settingDefinition`(`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` text NOT NULL,
	`createdAt` text,
	`updatedAt` text
);
--> statement-breakpoint
CREATE TABLE `workflow` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`version` text NOT NULL,
	`graph` text NOT NULL,
	`visibility` text DEFAULT 'private',
	`deleted` integer DEFAULT false,
	`deletedAt` integer,
	`deletedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deletedBy`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_user_slug_idx` ON `workflow` (`userId`,`slug`);--> statement-breakpoint
CREATE TABLE `workflowExecution` (
	`executionId` text PRIMARY KEY NOT NULL,
	`workflowId` text NOT NULL,
	`userId` text NOT NULL,
	`state` text NOT NULL,
	`currentNodeId` text,
	`waitingForInputNodeId` text,
	`context` text NOT NULL,
	`error` text,
	`note` text,
	`parentExecutionId` text,
	`createdAt` integer,
	`updatedAt` integer,
	`completedAt` integer,
	FOREIGN KEY (`workflowId`) REFERENCES `workflow`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workflow_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`workflow_id` text,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used` integer DEFAULT false,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
