ALTER TABLE codespaceCredentialRevocation ADD COLUMN credentialKind TEXT NOT NULL DEFAULT 'parent';
--> statement-breakpoint
ALTER TABLE codespaceCredentialRevocation ADD COLUMN state TEXT NOT NULL DEFAULT 'dispose_pending';
--> statement-breakpoint
ALTER TABLE codespaceCredentialRevocation ADD COLUMN requestId TEXT;
--> statement-breakpoint
ALTER TABLE codespaceCredentialRevocation ADD COLUMN scopeMetadata TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX codespace_scoped_credential_request_idx ON codespaceCredentialRevocation(userId,provider,requestId) WHERE credentialKind='scoped';
