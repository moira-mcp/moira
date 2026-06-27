ALTER TABLE `libraryEntry` ADD `importKey` text;--> statement-breakpoint
CREATE INDEX `library_entry_import_key_idx` ON `libraryEntry` (`userId`,`importKey`);