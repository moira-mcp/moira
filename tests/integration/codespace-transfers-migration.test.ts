import { describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");

function copyBeforeTransferMigration(directory: string): string {
  const target = path.join(directory, "before-codespace-transfers");
  fs.cpSync(migrations, target, { recursive: true });
  const journalPath = path.join(target, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const index = journal.entries.findIndex((entry) => entry.tag === "0030_workspace_transfers");
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return target;
}

describe("codespace transfer migration", () => {
  test("retains historical transfer metadata without active transfer authority", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-codespace-transfer-migration-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: copyBeforeTransferMigration(directory) });
      migrate(drizzle(sqlite), { migrationsFolder: migrations });
      const columns = (
        sqlite.prepare("PRAGMA table_info(archiveCommunicationTransfer)").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "tokenDigest",
          "userId",
          "purpose",
          "state",
          "declaredSize",
          "observedSize",
          "sha256",
          "objectKey",
          "ownerPid",
          "ownerStartTime",
          "expiresAt",
        ]),
      );
      expect(columns).not.toEqual(
        expect.arrayContaining(["bytes", "content", "downloadUrl", "sourceUrl"]),
      );
      expect(
        sqlite.prepare("SELECT name FROM sqlite_master WHERE name='codespaceTransfer'").get(),
      ).toBeUndefined();
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("archives complete uncertain transfer/grant rows unchanged and preserves their historical byte objects", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-owner-communication-upgrade-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      const before = path.join(directory, "before-owner");
      fs.cpSync(migrations, before, { recursive: true });
      const journalPath = path.join(before, "meta/_journal.json");
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
        entries: Array<{ tag: string }>;
      };
      const index = journal.entries.findIndex((entry) => entry.tag === "0065_owner_communication");
      expect(index).toBeGreaterThan(0);
      journal.entries = journal.entries.slice(0, index);
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      migrate(drizzle(sqlite), { migrationsFolder: before });
      sqlite
        .prepare(
          "INSERT INTO user(id,email,handle,createdAt,updatedAt) VALUES('existing','existing@example.test','existing','before','before')",
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO codespaceTransfer(id,tokenDigest,userId,purpose,state,fileName,mimeType,declaredSize,observedSize,objectKey,ownerPid,ownerStartTime,claimId,claimExpiresAt,expiresAt,createdAt,updatedAt,requestId,requestDigest,uploadedBytes)
        VALUES('original','digest','existing','input','receiving','old.bin','application/octet-stream',5,2,'original.bytes',999,'old-start','unknown-claim',1,2,3,4,'ws1-original','original-input',2)`,
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO communication_attachment_grant(token_digest,user_id,correlation_id,audience,purpose,message,format,silent,kind,filename,mime_type,declared_size,state,claim_id,claimed_at,expires_at,created_at)
        VALUES('grant-digest','existing','original-delivery','communication','attachment','private old caption','plain',0,'document','old.bin','application/octet-stream',5,'claimed','unconfirmed-original',1,2,3)`,
        )
        .run();
      const objectPath = path.join(directory, "original.bytes"),
        bytes = Buffer.from([0, 255, 1]);
      fs.writeFileSync(objectPath, bytes);
      const transfers = sqlite.prepare("SELECT * FROM codespaceTransfer").all();
      const grants = sqlite.prepare("SELECT * FROM communication_attachment_grant").all();
      const priorArchive = sqlite.prepare("SELECT * FROM archiveLocalResourceOperational").all();
      migrate(drizzle(sqlite), { migrationsFolder: migrations });
      expect(sqlite.prepare("SELECT * FROM archiveCommunicationTransfer").all()).toEqual(transfers);
      expect(sqlite.prepare("SELECT * FROM archiveCommunicationAttachmentGrant").all()).toEqual(
        grants,
      );
      expect(sqlite.prepare("SELECT * FROM archiveLocalResourceOperational").all()).toEqual(
        priorArchive,
      );
      expect(fs.readFileSync(objectPath)).toEqual(bytes);
      expect(
        sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('codespaceTransfer','communication_attachment_grant')",
          )
          .all(),
      ).toEqual([]);
      for (const table of ["archiveCommunicationTransfer", "archiveCommunicationAttachmentGrant"]) {
        expect(() => sqlite.exec(`DELETE FROM ${table}`)).toThrow("Read-only historical archive");
        expect(() => sqlite.exec(`INSERT INTO ${table} SELECT * FROM ${table}`)).toThrow(
          "Read-only historical archive",
        );
      }
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rolls back the complete transfer table on migration failure", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-codespace-transfer-rollback-"));
    const before = copyBeforeTransferMigration(directory);
    const failed = path.join(directory, "failed");
    fs.cpSync(migrations, failed, { recursive: true });
    fs.appendFileSync(
      path.join(failed, "0030_workspace_transfers.sql"),
      "\n--> statement-breakpoint\nCREATE TABLE invalid_codespace_transfer_migration (\n",
    );
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: before });
      expect(() => migrate(drizzle(sqlite), { migrationsFolder: failed })).toThrow();
      expect(
        sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'workspaceTransfer'").get(),
      ).toBeUndefined();
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
