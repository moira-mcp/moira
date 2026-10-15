import { mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { writeDurableJson, persistDirectory } from "./file-primitives.mjs";
import { readPrivateOwnerJson } from "./private-json.mjs";
import { WORKSPACE_REQUEST_ID_PATTERN } from "../../shared/src/codespaces/workspace-request-id.ts";

/** Security receipts use the existing workspace operation namespace and CLI status surface. */
export function credentialWorkspaceStore(stateRoot) {
  const root = join(stateRoot, "requests");
  return {
    read: async (requestId) => {
      if (!WORKSPACE_REQUEST_ID_PATTERN.test(requestId))
        throw new Error("Invalid security identity");
      const directory = join(root, requestId);
      const accepted = await readPrivateOwnerJson(join(directory, "accepted.json"));
      if (!accepted) return null;
      if (accepted.kind !== "security-acquisition") throw new Error("Request identity conflict");
      return (await readPrivateOwnerJson(join(directory, "result.json"))) ?? accepted.security;
    },
    write: async (requestId, record) => {
      if (!WORKSPACE_REQUEST_ID_PATTERN.test(requestId))
        throw new Error("Invalid security identity");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = join(root, requestId);
      await mkdir(directory, { mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      for (const path of [root, directory]) {
        const info = await lstat(path);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid?.() ||
          info.mode & 0o077
        )
          throw new Error("Unsafe security receipt directory");
      }
      await persistDirectory(directory);
      const accepted = await readPrivateOwnerJson(join(directory, "accepted.json"));
      if (accepted && accepted.kind !== "security-acquisition")
        throw new Error("Request identity conflict");
      if (!accepted)
        await writeDurableJson(directory, "accepted.json", {
          kind: "security-acquisition",
          security: record,
        });
      await writeDurableJson(directory, "result.json", record);
    },
  };
}
