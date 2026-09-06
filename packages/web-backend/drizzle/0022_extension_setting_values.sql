CREATE TABLE `extensionSettingValue` (
	`userId` text NOT NULL,
	`settingKey` text NOT NULL,
	`value` text NOT NULL,
	`encrypted` integer DEFAULT false NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `settingKey`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
