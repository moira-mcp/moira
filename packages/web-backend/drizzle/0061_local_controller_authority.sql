CREATE TABLE archiveCodespaceLocalDevice AS SELECT * FROM codespaceLocalDevice;
--> statement-breakpoint
CREATE TABLE archiveCodespaceLocalRelay AS SELECT * FROM codespaceLocalRelay;
--> statement-breakpoint
CREATE TABLE archiveCodespaceLocalRelayPart AS SELECT * FROM codespaceLocalRelayPart;
--> statement-breakpoint
CREATE TABLE archiveLocalConnectionRepository AS SELECT r.* FROM codespaceConnectionRepository r JOIN codespaceConnection c ON c.id=r.connectionId WHERE c.provider='local-sandboxes';
--> statement-breakpoint
CREATE TABLE archiveLocalProviderMutation AS SELECT * FROM codespaceProviderMutation WHERE provider='local-sandboxes';
--> statement-breakpoint
CREATE TABLE archiveLocalPolicyUsage AS SELECT * FROM codespacePolicyUsage WHERE provider='local-sandboxes';
--> statement-breakpoint
CREATE TABLE archiveLocalResourceOperational AS SELECT * FROM codespaceResource WHERE provider='local-sandboxes';
--> statement-breakpoint
DELETE FROM codespaceProviderMutation WHERE provider='local-sandboxes';
--> statement-breakpoint
DELETE FROM codespacePolicyUsage WHERE provider='local-sandboxes';
--> statement-breakpoint
DROP TABLE codespaceLocalRelayPart;
--> statement-breakpoint
DROP TABLE codespaceLocalRelay;
--> statement-breakpoint
ALTER TABLE codespaceLocalDevice DROP COLUMN policy;
--> statement-breakpoint
ALTER TABLE codespaceLocalDevice DROP COLUMN policyDigest;
--> statement-breakpoint
ALTER TABLE codespaceLocalDevice DROP COLUMN control;
--> statement-breakpoint
ALTER TABLE codespaceLocalResourceBinding ADD COLUMN revokedAt INTEGER;
--> statement-breakpoint
DELETE FROM codespaceConnectionRepository WHERE connectionId IN (SELECT id FROM codespaceConnection WHERE provider='local-sandboxes');
--> statement-breakpoint
CREATE TRIGGER archive_local_device_no_insert BEFORE INSERT ON archiveCodespaceLocalDevice BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_device_no_update BEFORE UPDATE ON archiveCodespaceLocalDevice BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_device_no_delete BEFORE DELETE ON archiveCodespaceLocalDevice BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_relay_no_insert BEFORE INSERT ON archiveCodespaceLocalRelay BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_relay_no_update BEFORE UPDATE ON archiveCodespaceLocalRelay BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_relay_no_delete BEFORE DELETE ON archiveCodespaceLocalRelay BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_part_no_insert BEFORE INSERT ON archiveCodespaceLocalRelayPart BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_part_no_update BEFORE UPDATE ON archiveCodespaceLocalRelayPart BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_part_no_delete BEFORE DELETE ON archiveCodespaceLocalRelayPart BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_grant_no_insert BEFORE INSERT ON archiveLocalConnectionRepository BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_grant_no_update BEFORE UPDATE ON archiveLocalConnectionRepository BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_grant_no_delete BEFORE DELETE ON archiveLocalConnectionRepository BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_mutation_no_insert BEFORE INSERT ON archiveLocalProviderMutation BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_mutation_no_update BEFORE UPDATE ON archiveLocalProviderMutation BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_mutation_no_delete BEFORE DELETE ON archiveLocalProviderMutation BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_usage_no_insert BEFORE INSERT ON archiveLocalPolicyUsage BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_usage_no_update BEFORE UPDATE ON archiveLocalPolicyUsage BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_usage_no_delete BEFORE DELETE ON archiveLocalPolicyUsage BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_resource_no_insert BEFORE INSERT ON archiveLocalResourceOperational BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_resource_no_update BEFORE UPDATE ON archiveLocalResourceOperational BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_local_resource_no_delete BEFORE DELETE ON archiveLocalResourceOperational BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
