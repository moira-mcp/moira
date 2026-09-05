import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "@jest/globals";

const migration = readFileSync(
  resolve(process.cwd(), "packages/web-backend/drizzle/0021_static_tool_descriptions.sql"),
  "utf8",
);

describe("static tool-description migration", () => {
  test("removes only default, agent, and model tool-description settings", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE globalSetting (key TEXT PRIMARY KEY, value TEXT)");
    sqlite.exec("CREATE TABLE apiToken (id TEXT PRIMARY KEY, tokenHash TEXT NOT NULL)");
    const insert = sqlite.prepare("INSERT INTO globalSetting (key, value) VALUES (?, ?)");
    for (const key of [
      "mcp.toolDescription.list",
      "mcp.agent.cursor.toolDescription.step",
      "mcp.agent.cursor.model.small.toolDescription.step",
      "mcp.systemPrompt",
      "mcp.systemReminder",
      "mcp.agent.cursor.systemReminder",
      "mcp.errorMessages",
      "mcp.validationHelp",
      "unrelated.setting",
    ]) {
      insert.run(key, key);
    }

    sqlite.exec(migration);
    const remaining = sqlite.prepare("SELECT key FROM globalSetting ORDER BY key").all() as Array<{
      key: string;
    }>;
    sqlite.close();

    expect(remaining.map(({ key }) => key)).toEqual([
      "mcp.agent.cursor.systemReminder",
      "mcp.errorMessages",
      "mcp.systemPrompt",
      "mcp.systemReminder",
      "mcp.validationHelp",
      "unrelated.setting",
    ]);
  });

  test("adds nullable catalog revision without changing existing persistent token identity", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE globalSetting (key TEXT PRIMARY KEY, value TEXT)");
    sqlite.exec("CREATE TABLE apiToken (id TEXT PRIMARY KEY, tokenHash TEXT NOT NULL)");
    sqlite.prepare("INSERT INTO apiToken (id, tokenHash) VALUES (?, ?)").run("token-1", "hash-1");

    sqlite.exec(migration);

    const columns = sqlite.prepare("PRAGMA table_info(apiToken)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const row = sqlite
      .prepare("SELECT id, tokenHash, toolsVersion FROM apiToken WHERE id = ?")
      .get("token-1");
    sqlite.close();

    expect(columns.find(({ name }) => name === "toolsVersion")).toEqual(
      expect.objectContaining({ notnull: 0 }),
    );
    expect(row).toEqual({ id: "token-1", tokenHash: "hash-1", toolsVersion: null });
  });
});
