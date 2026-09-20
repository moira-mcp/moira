import { afterEach, describe, expect, test } from "@jest/globals";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateCodespaceTransferRoot } from "../../../packages/web-backend/src/services/codespace-services.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "moira-codespace-transfer-root-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("codespace transfer-root migration", () => {
  test("moves a legacy root and merges non-conflicting objects without losing bytes", () => {
    const movedParent = temporaryDirectory();
    const legacy = join(movedParent, "workspace-transfers");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "legacy-object"), "legacy-bytes");

    const moved = migrateCodespaceTransferRoot(movedParent);

    expect(moved).toBe(join(movedParent, "codespace-transfers"));
    expect(readFileSync(join(moved, "legacy-object"), "utf8")).toBe("legacy-bytes");
    expect(existsSync(legacy)).toBe(false);

    const mergedParent = temporaryDirectory();
    const mergedLegacy = join(mergedParent, "workspace-transfers");
    const current = join(mergedParent, "codespace-transfers");
    mkdirSync(mergedLegacy);
    mkdirSync(current);
    writeFileSync(join(mergedLegacy, "old-object"), "old-bytes");
    writeFileSync(join(current, "new-object"), "new-bytes");

    expect(migrateCodespaceTransferRoot(mergedParent)).toBe(current);
    expect(readFileSync(join(current, "old-object"), "utf8")).toBe("old-bytes");
    expect(readFileSync(join(current, "new-object"), "utf8")).toBe("new-bytes");
    expect(existsSync(mergedLegacy)).toBe(false);
  });

  test("fails before overwriting an object that exists in both roots", () => {
    const parent = temporaryDirectory();
    const legacy = join(parent, "workspace-transfers");
    const current = join(parent, "codespace-transfers");
    mkdirSync(legacy);
    mkdirSync(current);
    writeFileSync(join(legacy, "same-object"), "legacy-bytes");
    writeFileSync(join(current, "same-object"), "current-bytes");

    expect(() => migrateCodespaceTransferRoot(parent)).toThrow(/same-object/);
    expect(readFileSync(join(legacy, "same-object"), "utf8")).toBe("legacy-bytes");
    expect(readFileSync(join(current, "same-object"), "utf8")).toBe("current-bytes");
  });
});
