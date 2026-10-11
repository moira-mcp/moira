ALTER TABLE codespaceOperation ADD COLUMN requestId text;
--> statement-breakpoint
ALTER TABLE codespaceOperation ADD COLUMN requestDigest text;
--> statement-breakpoint
ALTER TABLE codespaceOperation ADD COLUMN inputReference text;
--> statement-breakpoint
ALTER TABLE codespaceOperation ADD COLUMN resultReference text;
--> statement-breakpoint
ALTER TABLE codespaceOperation ADD COLUMN admissionDeadlineAt integer;
--> statement-breakpoint
ALTER TABLE codespaceOperation ADD COLUMN runtimeMs integer;
--> statement-breakpoint
ALTER TABLE codespaceOperation ADD COLUMN startedAt integer;
--> statement-breakpoint
ALTER TABLE codespaceOperation ADD COLUMN sessionKey text;
--> statement-breakpoint
CREATE UNIQUE INDEX codespace_operation_request_idx ON codespaceOperation(userId,requestId);
--> statement-breakpoint
ALTER TABLE codespaceLocalRelay ADD COLUMN settlementClaimId text;
--> statement-breakpoint
UPDATE codespaceLocalRelay SET settlementClaimId=claimId WHERE claimId IS NOT NULL;
