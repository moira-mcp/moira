/**
 * What the runner agrees to host, and what it refuses with a reason.
 *
 * A refusal has to be specific and it has to be local: one unusable bundle must not deny the
 * installation the bundles that are fine, and an operator must learn which directory to fix
 * without reading logs from inside a handler process.
 */

import { describe, test, expect } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { scanExtensionBundles } from "@mcp-moira/extension-runner";

const REJECTS_DIR = path.resolve(process.cwd(), "tests/fixtures/extension-bundles-rejects");
const BUNDLES_DIR = path.resolve(process.cwd(), "tests/fixtures/extension-bundles");

describe("Bundle discovery", () => {
  test("a well-formed bundle is loaded with its entrypoint resolved", () => {
    const result = scanExtensionBundles(BUNDLES_DIR);

    expect(result.rejected).toEqual([]);
    expect(result.bundles.map((bundle) => bundle.manifest.name)).toEqual([
      "channel-probe",
      "probe",
      "scribe",
    ]);
    expect(result.bundles.every((bundle) => fs.existsSync(bundle.entrypoint))).toBe(true);
  });

  test("a missing directory is the ordinary no-extensions state, not an error", () => {
    const result = scanExtensionBundles(path.join(os.tmpdir(), "moira-no-such-extensions-dir"));

    expect(result.bundles).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  test("a bundle for another contract version is refused, naming both versions", () => {
    const result = scanExtensionBundles(REJECTS_DIR);

    const wrongVersion = result.rejected.find(
      (entry) => path.basename(entry.directory) === "wrong-version",
    );

    expect(wrongVersion).toBeDefined();
    expect(wrongVersion!.reasons.join(" ")).toContain("moira.extensions/v99");
    expect(wrongVersion!.reasons.join(" ")).toContain("moira.extensions/v1");
  });

  test("two bundles claiming one node type: exactly one loads and the refusal names the other", () => {
    // Which of the two wins is decided by directory order and is not the point; the contract is
    // that the type is never served by two bundles at once and that the refusal names the winner,
    // so an operator knows which directory to remove.
    const result = scanExtensionBundles(REJECTS_DIR);

    const claimants = ["conflicting", "probe-extension"];
    const loaded = result.bundles.filter((bundle) =>
      claimants.includes(path.basename(bundle.directory)),
    );
    const refused = result.rejected.filter((entry) =>
      claimants.includes(path.basename(entry.directory)),
    );

    expect(loaded).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reasons.join(" ")).toContain("probe.behave");
    expect(refused[0].reasons.join(" ")).toContain(path.basename(loaded[0].directory));
  });

  test("a bundle refused for any reason does not prevent a healthy one from loading", () => {
    const result = scanExtensionBundles(REJECTS_DIR);

    expect(result.bundles.map((bundle) => bundle.manifest.name)).toEqual(["probe"]);
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  test.each([
    [
      "secret permissions",
      { permissions: { secrets: {}, network: ["api.example.com"] } },
      "permissions.secrets",
    ],
    [
      "network permissions",
      { permissions: { secrets: ["broken.token"], network: {} } },
      "permissions.network",
    ],
    ["nonsecret settings", { settings: {} }, "settings"],
    ["null transport", { binaryTransport: null }, "binaryTransport"],
    ["false transport", { binaryTransport: false }, "binaryTransport"],
  ])(
    "a malformed binary channel's %s rejects only its bundle",
    (_label, channelOverride, reason) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-binary-manifest-"));
      const channel = {
        id: "broken.files",
        title: "Files",
        capabilities: { text: true, image: false, document: true },
        configurationSchema: { type: "object" },
        enabledSetting: "broken.enabled",
        settings: ["broken.enabled", "broken.recipient"],
        permissions: { secrets: ["broken.token"], network: ["api.example.com"] },
        binaryTransport: {
          operations: [
            {
              id: "upload",
              endpoint: { url: "https://api.example.com/files" },
              method: "POST",
              credential: { header: "authorization", secret: "broken.token" },
              recipient: { field: "chat", setting: "broken.recipient" },
              body: { mode: "multipart", fileField: "file" },
            },
          ],
        },
        ...channelOverride,
      };
      const healthy = {
        apiVersion: "moira.extensions/v1",
        name: "healthy",
        version: "1.0.0",
        entrypoint: "index.ts",
        nodes: [{ type: "healthy.go", title: "Go", configSchema: {}, outputSchema: {} }],
      };
      const broken = {
        ...healthy,
        name: "broken",
        nodes: [{ type: "broken.go", title: "Go", configSchema: {}, outputSchema: {} }],
        settings: [
          { key: "broken.enabled", type: "boolean", label: "Enabled" },
          { key: "broken.recipient", type: "string", label: "Recipient" },
          { key: "broken.token", type: "encrypted", label: "Token" },
        ],
        communicationChannels: [channel],
      };
      try {
        for (const manifest of [broken, healthy]) {
          const bundle = path.join(directory, manifest.name);
          fs.mkdirSync(bundle);
          fs.writeFileSync(path.join(bundle, "index.ts"), "export default { nodes: [] };", "utf-8");
          fs.writeFileSync(
            path.join(bundle, "moira-extension.json"),
            JSON.stringify(manifest),
            "utf-8",
          );
        }
        const result = scanExtensionBundles(directory);
        expect(result.bundles.map((bundle) => bundle.manifest.name)).toEqual(["healthy"]);
        expect(result.rejected).toHaveLength(1);
        expect(path.basename(result.rejected[0].directory)).toBe("broken");
        expect(result.rejected[0].reasons.join(" ")).toContain(reason);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test("two bundles claiming one settings key: exactly one loads and both names appear", () => {
    // Two copies of one extension name can carry different node types while still claiming one
    // setting. The bundle is refused as a whole, and the key-specific reason remains useful to an
    // operator comparing the two copies.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-settings-"));
    for (const name of ["alpha", "beta"]) {
      const bundle = path.join(dir, name);
      fs.mkdirSync(bundle);
      fs.writeFileSync(path.join(bundle, "index.ts"), "export default { nodes: [] };", "utf-8");
      fs.writeFileSync(
        path.join(bundle, "moira-extension.json"),
        JSON.stringify({
          apiVersion: "moira.extensions/v1",
          name: "shared",
          version: "1.0.0",
          entrypoint: "index.ts",
          nodes: [{ type: `shared.${name}`, title: "Go", configSchema: {}, outputSchema: {} }],
          settings: [{ key: "shared.token", type: "encrypted", label: "Token" }],
        }),
        "utf-8",
      );
    }

    try {
      const result = scanExtensionBundles(dir);

      expect(result.bundles).toHaveLength(1);
      expect(result.rejected).toHaveLength(1);
      const reasons = result.rejected[0].reasons.join(" ");
      expect(reasons).toContain("shared.token");
      // Both claimants are named: the refused directory is the entry itself, and the reason names
      // the one that already owns the key.
      expect(reasons).toContain(path.basename(result.bundles[0].directory));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an entrypoint pointing outside its bundle is refused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-escape-"));
    const bundle = path.join(dir, "escaper");
    fs.mkdirSync(bundle);
    fs.writeFileSync(
      path.join(bundle, "moira-extension.json"),
      JSON.stringify({
        apiVersion: "moira.extensions/v1",
        name: "escaper",
        version: "1.0.0",
        entrypoint: "../../outside.ts",
        nodes: [{ type: "escaper.go", title: "Go", configSchema: {}, outputSchema: {} }],
      }),
      "utf-8",
    );

    try {
      const result = scanExtensionBundles(dir);

      expect(result.bundles).toEqual([]);
      expect(result.rejected[0].reasons.join(" ")).toContain("stay inside the bundle directory");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an entrypoint symlink resolving outside its bundle is refused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-symlink-escape-"));
    const bundle = path.join(dir, "escaper");
    const outside = path.join(dir, "outside.ts");
    fs.mkdirSync(bundle);
    fs.writeFileSync(outside, "export default { nodes: [] };", "utf-8");
    fs.symlinkSync(outside, path.join(bundle, "index.ts"));
    fs.writeFileSync(
      path.join(bundle, "moira-extension.json"),
      JSON.stringify({
        apiVersion: "moira.extensions/v1",
        name: "escaper",
        version: "1.0.0",
        entrypoint: "index.ts",
        nodes: [{ type: "escaper.go", title: "Go", configSchema: {}, outputSchema: {} }],
      }),
      "utf-8",
    );

    try {
      const result = scanExtensionBundles(dir);
      expect(result.bundles).toEqual([]);
      expect(result.rejected[0].reasons.join(" ")).toContain("symlink outside");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
