import express from "express";
import { createServer } from "node:https";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodespaceFileTransferService } from "@mcp-moira/shared";
import { createCodespaceFileRoutes } from "../../packages/web-backend/src/routes/codespace-files.js";

/** Real private-file routes shared by the cloud and Local consumer fixtures. */
export async function nativeFileTls(
  root: string,
  service: () => CodespaceFileTransferService,
  port = 3100,
) {
  const keyPath = join(root, "key.pem");
  const caPath = join(root, "cert.pem");
  const certificate = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      caPath,
    ],
    { encoding: "utf8" },
  );
  if (certificate.status !== 0) throw new Error("Could not create the isolated TLS fixture");
  const app = express();
  app.use("/api/public/codespace-files", createCodespaceFileRoutes(service));
  const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(caPath) }, app);
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  return {
    origin: `https://127.0.0.1:${port}`,
    caPath,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
