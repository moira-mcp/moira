import type Database from "better-sqlite3";
import {
  CODESPACE_IDLE_TIMEOUT_MINUTES,
  type CodespaceRepositoryTarget,
} from "./resource-types.js";
export { CODESPACE_IDLE_TIMEOUT_MINUTES } from "./resource-types.js";
export const CODESPACE_AUTO_STOP_SETTING = "codespaces.auto_stop_enabled";
export const CODESPACE_IDLE_TIMEOUT_SETTING = "codespaces.idle_timeout_minutes";
/** Current repository grants and provider settings, independent of resource storage. */
export class CodespaceRepositorySettings {
  constructor(private readonly sqlite: Database.Database) {}
  listApprovedRepositories(userId: string, provider: string): CodespaceRepositoryTarget[] {
    const rows = this.sqlite
      .prepare(
        `SELECT r.externalRepositoryId,r.fullName,r.private FROM codespaceConnection c
      JOIN codespaceConnectionRepository r ON r.connectionId=c.id WHERE c.userId=? AND c.provider=? AND c.status='connected' ORDER BY r.fullName`,
      )
      .all(userId, provider) as Array<{
      externalRepositoryId: string;
      fullName: string;
      private: number;
    }>;
    return rows.map((row) => ({
      id: row.externalRepositoryId,
      fullName: row.fullName,
      private: Boolean(row.private),
    }));
  }
  getApprovedConnection(userId: string, provider: string, repositoryId: string) {
    const row = this.sqlite
      .prepare(
        `SELECT c.id connectionId,c.externalAccountId,c.credentialGeneration authorizationGeneration,
      r.externalRepositoryId,r.fullName,r.private FROM codespaceConnection c JOIN codespaceConnectionRepository r ON r.connectionId=c.id
      WHERE c.userId=? AND c.provider=? AND c.status='connected' AND r.externalRepositoryId=?`,
      )
      .get(userId, provider, repositoryId) as
      | {
          connectionId: string;
          externalAccountId: string;
          authorizationGeneration: number;
          externalRepositoryId: string;
          fullName: string;
          private: number;
        }
      | undefined;
    return row
      ? {
          connectionId: row.connectionId,
          externalAccountId: row.externalAccountId,
          authorizationGeneration: row.authorizationGeneration,
          repository: {
            id: row.externalRepositoryId,
            fullName: row.fullName,
            private: Boolean(row.private),
          },
        }
      : null;
  }
  idlePolicy(userId: string) {
    const setting = (key: string, fallback: string) =>
      (
        this.sqlite
          .prepare(
            `SELECT COALESCE(
      (SELECT value FROM userSettingValue WHERE userId=? AND settingKey=?),
      (SELECT defaultValue FROM settingDefinition WHERE key=?),?) value`,
          )
          .get(userId, key, key, fallback) as { value: string }
      ).value;
    const value = Number(
      setting(CODESPACE_IDLE_TIMEOUT_SETTING, String(CODESPACE_IDLE_TIMEOUT_MINUTES.default)),
    );
    return {
      autoStopEnabled: ["true", "1"].includes(setting(CODESPACE_AUTO_STOP_SETTING, "true")),
      idleTimeoutMinutes:
        Number.isInteger(value) &&
        value >= CODESPACE_IDLE_TIMEOUT_MINUTES.minimum &&
        value <= CODESPACE_IDLE_TIMEOUT_MINUTES.maximum
          ? value
          : CODESPACE_IDLE_TIMEOUT_MINUTES.default,
    };
  }
}
