CREATE TABLE archiveGithubResourceOperational AS SELECT * FROM codespaceResource WHERE provider='github-codespaces';
--> statement-breakpoint
CREATE TABLE archiveCodespaceProviderMutation AS SELECT * FROM codespaceProviderMutation;
--> statement-breakpoint
CREATE TABLE archiveCodespaceOperation AS SELECT * FROM codespaceOperation;
--> statement-breakpoint
CREATE TABLE archiveCodespacePolicyUsage AS SELECT * FROM codespacePolicyUsage;
--> statement-breakpoint
CREATE TABLE archiveCodespaceLifecycleCapability AS SELECT * FROM codespaceLifecycleCapability;
--> statement-breakpoint
CREATE TABLE archiveCodespaceProviderControl AS SELECT * FROM codespaceProviderControl;
--> statement-breakpoint
ALTER TABLE codespaceConnection ADD COLUMN authorityGeneration INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
UPDATE codespaceConnection SET authorityGeneration=credentialGeneration;
--> statement-breakpoint
CREATE TABLE githubResourceIdentity (
 id TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL REFERENCES user(id),
 connectionId TEXT NOT NULL REFERENCES codespaceConnection(id), authorizationGeneration INTEGER NOT NULL,
 repositoryId TEXT NOT NULL, repositoryFullName TEXT NOT NULL, requestedRef TEXT NOT NULL,
 devcontainerPath TEXT, operationMarker TEXT NOT NULL UNIQUE, providerResourceName TEXT UNIQUE,
 externalOwnerId TEXT NOT NULL, billableOwnerId TEXT NOT NULL,
 deviceId TEXT, deviceGeneration INTEGER, deviceConnectionId TEXT,
 generation INTEGER NOT NULL, retirement TEXT NOT NULL CHECK(retirement IN ('uncreated','unknown','owned','retired')),
 revokedAt INTEGER, createdAt INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE githubWorkspaceRenewal (
 resourceId TEXT PRIMARY KEY NOT NULL REFERENCES githubResourceIdentity(id),
 userId TEXT NOT NULL REFERENCES user(id), credentialDigest TEXT NOT NULL UNIQUE,
 resourceGeneration INTEGER NOT NULL, authorizationGeneration INTEGER NOT NULL,
 root TEXT NOT NULL, rootDevice TEXT NOT NULL, rootInode TEXT NOT NULL, release TEXT NOT NULL,
 enrollmentRequestId TEXT NOT NULL, enrollmentDigest TEXT NOT NULL,
 currentRequestId TEXT, currentEnvironmentIdentity TEXT
);
--> statement-breakpoint
INSERT INTO githubResourceIdentity SELECT id,userId,connectionId,authorizationGeneration,repositoryId,
 repositoryFullName,requestedRef,NULL,operationMarker,providerResourceName,
 COALESCE(externalOwnerId,(SELECT externalAccountId FROM codespaceConnection WHERE id=connectionId)),
 COALESCE(billableOwnerId,externalOwnerId,(SELECT externalAccountId FROM codespaceConnection WHERE id=connectionId)),
 NULL,NULL,NULL,generation,CASE WHEN providerResourceName IS NULL THEN 'unknown' WHEN state='deleted' THEN 'retired' ELSE 'owned' END,
 NULL,createdAt FROM codespaceResource WHERE provider='github-codespaces';
--> statement-breakpoint
CREATE TABLE workspaceAgentCredentialNext (
 resourceId TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 credentialDigest TEXT NOT NULL UNIQUE,resourceGeneration INTEGER NOT NULL,authorizationGeneration INTEGER NOT NULL,
 environmentIdentity TEXT NOT NULL,expiresAt INTEGER,createdAt INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO workspaceAgentCredentialNext SELECT * FROM workspaceAgentCredential;
--> statement-breakpoint
DROP TABLE workspaceAgentCredential;
--> statement-breakpoint
ALTER TABLE workspaceAgentCredentialNext RENAME TO workspaceAgentCredential;
--> statement-breakpoint
DROP TABLE codespaceOperation;
--> statement-breakpoint
DROP TABLE codespaceProviderMutation;
--> statement-breakpoint
DROP TABLE codespacePolicyUsage;
--> statement-breakpoint
DROP TABLE codespaceLifecycleCapability;
--> statement-breakpoint
DROP TABLE codespaceProviderControl;
--> statement-breakpoint
ALTER TABLE codespaceConnection DROP COLUMN resourcesObservedAt;
--> statement-breakpoint
DELETE FROM codespaceResource WHERE provider='github-codespaces';
--> statement-breakpoint
CREATE TRIGGER archive_gh_resource_insert BEFORE INSERT ON archiveGithubResourceOperational BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_resource_update BEFORE UPDATE ON archiveGithubResourceOperational BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_resource_delete BEFORE DELETE ON archiveGithubResourceOperational BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_mutation_insert BEFORE INSERT ON archiveCodespaceProviderMutation BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_mutation_update BEFORE UPDATE ON archiveCodespaceProviderMutation BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_mutation_delete BEFORE DELETE ON archiveCodespaceProviderMutation BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_operation_insert BEFORE INSERT ON archiveCodespaceOperation BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_operation_update BEFORE UPDATE ON archiveCodespaceOperation BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_operation_delete BEFORE DELETE ON archiveCodespaceOperation BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_usage_insert BEFORE INSERT ON archiveCodespacePolicyUsage BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_usage_update BEFORE UPDATE ON archiveCodespacePolicyUsage BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_usage_delete BEFORE DELETE ON archiveCodespacePolicyUsage BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_capability_insert BEFORE INSERT ON archiveCodespaceLifecycleCapability BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_capability_update BEFORE UPDATE ON archiveCodespaceLifecycleCapability BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_gh_capability_delete BEFORE DELETE ON archiveCodespaceLifecycleCapability BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_control_insert BEFORE INSERT ON archiveCodespaceProviderControl BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_control_update BEFORE UPDATE ON archiveCodespaceProviderControl BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_control_delete BEFORE DELETE ON archiveCodespaceProviderControl BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
