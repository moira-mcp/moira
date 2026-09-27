-- The last upstream state of each bundled playbook, so the catalog's three-way reconciliation can
-- tell a local edit from an upstream change.
CREATE TABLE `managedPlaybookBaseline` (
	`ownerId` text NOT NULL,
	`slug` text NOT NULL,
	`state` text NOT NULL,
	`sourceVersion` text,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`ownerId`, `slug`)
);
