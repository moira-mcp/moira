CREATE TABLE archiveCommunicationTransfer AS SELECT * FROM codespaceTransfer;
--> statement-breakpoint
CREATE TABLE archiveCommunicationAttachmentGrant AS SELECT * FROM communication_attachment_grant;
--> statement-breakpoint
DROP TABLE codespaceTransfer;
--> statement-breakpoint
DROP TABLE communication_attachment_grant;
--> statement-breakpoint
CREATE TRIGGER archive_communication_transfer_insert BEFORE INSERT ON archiveCommunicationTransfer BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_communication_transfer_update BEFORE UPDATE ON archiveCommunicationTransfer BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_communication_transfer_delete BEFORE DELETE ON archiveCommunicationTransfer BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_communication_grant_insert BEFORE INSERT ON archiveCommunicationAttachmentGrant BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_communication_grant_update BEFORE UPDATE ON archiveCommunicationAttachmentGrant BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
--> statement-breakpoint
CREATE TRIGGER archive_communication_grant_delete BEFORE DELETE ON archiveCommunicationAttachmentGrant BEGIN SELECT RAISE(ABORT,'Read-only historical archive'); END;
