/** Real controller publications against the selected baked backend; no physical VM or vendor. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type Socket } from "node:net";
import { createServer } from "node:tls";
import { createInterface } from "node:readline";
import { buildWorkspaceService } from "../../scripts/build-workspace-service.js";
import { createTestUser, getSessionCookieHeader } from "../e2e/helpers/auth-helper.js";
import { getAdminCredentials, getTestFetchUrl } from "../utils/test-config.js";

export async function browserPublicationOwner(bridgePort: number) {
  const target = new URL(getTestFetchUrl());
  if (target.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(target.hostname))
    throw new Error("Browser publication fixture requires an explicitly selected loopback backend");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "moira-browser-owner-")));
  const email = `browser-owner-${randomUUID()}@example.com`;
  const password = `Fixture-${randomBytes(24).toString("base64url")}!9`;
  const credential = randomBytes(32).toString("base64url");
  const cleanup: Array<() => Promise<unknown>> = [() => rm(directory, { recursive: true })];
  async function request(path: string, cookie: string | undefined, method = "GET", body?: unknown) {
    const response = await fetch(new URL(path, target), {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || !result.success)
      throw new Error(
        `Browser owner ${method} ${path}: ${response.status} ${result.error?.code ?? "refused"}`,
      );
    return result.data;
  }
  const close = async () => {
    const errors: unknown[] = [];
    for (const dispose of cleanup.splice(0).reverse()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Browser owner cleanup failed");
  };
  try {
    await buildWorkspaceService("packages/local/dist/owner-runtime");
    const created = await createTestUser(email, password, "Browser publication owner", true);
    if (!created.success || !created.userId)
      throw new Error("Browser owner account creation failed");
    const admin = getAdminCredentials();
    const adminCookie = await getSessionCookieHeader(admin.email, admin.password);
    cleanup.push(() => request(`/api/admin/users/${created.userId}`, adminCookie, "DELETE"));
    const cookie = await getSessionCookieHeader(email, password);
    const pair = await request("/api/integrations/local/pairings", cookie, "POST", {});
    const deviceId = randomUUID();
    await request("/api/local-devices/enroll", undefined, "POST", {
      pairingId: pair.pairingId,
      pairingToken: pair.pairingToken,
      credential,
      deviceId,
      label: "Browser publication fixture",
    });
    const status = await request("/api/local-devices/pairings/status", undefined, "POST", {
      pairingId: pair.pairingId,
      pairingToken: pair.pairingToken,
    });
    const identity = await request(
      `/api/integrations/local/pairings/${pair.pairingId}/confirm`,
      cookie,
      "POST",
      {
        expectedRevision: status.pairing.revision,
      },
    );
    cleanup.push(() =>
      request(`/api/integrations/local/devices/${deviceId}`, cookie, "DELETE", {
        expectedGeneration: identity.deviceGeneration,
      }),
    );
    const key = join(directory, "key.pem"),
      ca = join(directory, "ca.pem");
    const certificate = spawn(
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
        key,
        "-out",
        ca,
      ],
      { stdio: "ignore" },
    );
    const [certificateCode] = await once(certificate, "close");
    if (certificateCode !== 0) throw new Error("Browser owner certificate creation failed");
    await chmod(key, 0o600);
    const sockets = new Set<Socket>();
    const bridge = createServer(
      { key: await readFile(key), cert: await readFile(ca) },
      (incoming) => {
        const upstream = connect({ host: "127.0.0.1", port: Number(target.port || 80) });
        for (const socket of [incoming, upstream]) {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
          socket.on("error", () => {
            incoming.destroy();
            upstream.destroy();
          });
        }
        incoming.once("close", () => upstream.destroy());
        upstream.once("close", () => incoming.destroy());
        incoming.pipe(upstream).pipe(incoming);
      },
    );
    bridge.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    bridge.listen(bridgePort, "127.0.0.1");
    await once(bridge, "listening");
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        bridge.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const worker = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./browser-controller-worker.ts", import.meta.url)),
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NODE_EXTRA_CA_CERTS: ca },
      },
    );
    const exited = once(worker, "close");
    // The close result carries the original child failure; a later pipe write must not hide it.
    worker.stdin.on("error", () => {});
    const lines = createInterface({ input: worker.stdout });
    let stderr = "";
    worker.stderr.on("data", (bytes) => {
      stderr = (stderr + String(bytes)).slice(-4000);
    });
    cleanup.push(async () => {
      if (worker.exitCode === null && worker.signalCode === null) worker.stdin.end("close\n");
      const [code] = await exited;
      lines.close();
      if (code !== 0)
        throw new Error(
          `Browser controller exited ${code}: ${stderr.replaceAll(credential, "[redacted]")}`,
        );
    });
    worker.stdin.write(
      JSON.stringify({
        directory: join(directory, "owner"),
        connection: {
          origin: `https://127.0.0.1:${bridgePort}`,
          credential,
          pairingId: pair.pairingId,
          userId: created.userId,
          deviceId,
          deviceGeneration: identity.deviceGeneration,
          connectionId: identity.connectionId,
        },
      }) + "\n",
    );
    await Promise.race([
      (async () => {
        for await (const line of lines) if (line === "browser-controller-ready") return;
        throw new Error("Controller readiness absent");
      })(),
      exited.then(([code]) => {
        throw new Error(
          `Browser controller failed (${code}): ${stderr.replaceAll(credential, "[redacted]")}`,
        );
      }),
    ]);
    return { email, password, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Browser owner setup and cleanup failed");
    }
    throw error;
  }
}
