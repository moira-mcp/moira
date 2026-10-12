ALTER TABLE codespaceTransfer ADD COLUMN requestId TEXT;
--> statement-breakpoint
ALTER TABLE codespaceTransfer ADD COLUMN requestDigest TEXT;
--> statement-breakpoint
ALTER TABLE codespaceTransfer ADD COLUMN direction TEXT;
--> statement-breakpoint
ALTER TABLE codespaceTransfer ADD COLUMN resourceId TEXT;
--> statement-breakpoint
ALTER TABLE codespaceTransfer ADD COLUMN provider TEXT;
--> statement-breakpoint
ALTER TABLE codespaceTransfer ADD COLUMN resourceGeneration INTEGER;
--> statement-breakpoint
ALTER TABLE codespaceTransfer ADD COLUMN authorizationGeneration INTEGER;
--> statement-breakpoint
ALTER TABLE codespaceTransfer ADD COLUMN environmentIdentity TEXT;
--> statement-breakpoint
ALTER TABLE codespaceTransfer ADD COLUMN expectedSha256 TEXT;
--> statement-breakpoint
ALTER TABLE codespaceTransfer ADD COLUMN uploadedBytes INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE codespaceTransfer SET uploadedBytes = COALESCE(observedSize, 0);
--> statement-breakpoint
CREATE UNIQUE INDEX codespace_transfer_request_idx ON codespaceTransfer(userId, requestId);
