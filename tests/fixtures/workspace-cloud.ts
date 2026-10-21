import express from "express";
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { getSqliteInstance, closeDatabase } from "@mcp-moira/shared";
import {
  DatabaseRepository,
  CommunicationChannelRegistry,
  TelegramCommunicationAdapter,
} from "@mcp-moira/workflow-engine";
import {
  getWorkspaceRouter,
  stopWorkspaceRouter,
  authorizeWorkspacePublication,
} from "../../packages/web-backend/src/services/workspace-services.js";
import {
  WORKSPACE_ROUTER_SOCKET,
  getWorkspaceClient,
} from "../../packages/web-backend/src/services/workspace-client.js";
import { CommunicationOwnerTransport } from "../../packages/web-backend/src/services/communication-owner-transport.js";
import {
  authenticateCommunicationOwner,
  authorizeCommunicationOwner,
} from "../../packages/web-backend/src/services/communication-owner-authority.js";
import { createCommunicationOwnerRoutes } from "../../packages/web-backend/src/routes/communication-owner.js";
import { LiveCommunicationFileOwner } from "../../packages/web-backend/src/services/communication-file-owner.js";
import { createWorkspacePublicationHandler } from "../../packages/mcp-server/src/workspace-publication-route.js";
import { mcpLimiter } from "../../packages/mcp-server/src/middleware/rate-limit-middleware.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../../packages/mcp-server/src/tools/register-tools.js";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import type { CommunicationOwnerSubmit } from "@mcp-moira/shared";

/** Real application compositions in distinct processes; only the external vendor is substituted. */
export async function startCloudProcess(
  role: "backend" | "caller",
  config: { directory: string; userId: string },
) {
  const sqlite = getSqliteInstance();
  const app = express();
  let shutdown: () => Promise<void>;
  if (role === "backend") {
    let releaseVendor!: () => void;
    const vendorReply = new Promise<void>((done) => {
      releaseVendor = done;
    });
    process.on(
      "message",
      (message: { id: number; action: string; request: { resourceId?: string } }) => {
        if (message.action === "release-vendor") {
          releaseVendor();
          process.send?.({ id: message.id, result: { released: true } });
        }
      },
    );
    const repository = new DatabaseRepository();
    const transport = new CommunicationOwnerTransport({
      authenticate: authenticateCommunicationOwner,
      authorize: authorizeCommunicationOwner,
      repository,
      registry: new CommunicationChannelRegistry([new TelegramCommunicationAdapter()]),
      fetch: async (url, init) => {
        if (String(url) !== "https://api.telegram.org/bot123:fixture/sendDocument")
          throw new Error("Unexpected vendor destination");
        const chunks: Buffer[] = [];
        for await (const chunk of init!.body as unknown as AsyncIterable<Uint8Array>)
          chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        await appendFile(join(config.directory, "vendor-body"), body);
        await appendFile(join(config.directory, "vendor-effects"), "delivered\n");
        await vendorReply;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    app.use("/api/communication/owner", createCommunicationOwnerRoutes(transport));
    const server = createServer(
      {
        key: await readFile(join(config.directory, "key.pem")),
        cert: await readFile(join(config.directory, "ca.pem")),
      },
      app,
    );
    const router = getWorkspaceRouter();
    await router.listenPrivate(WORKSPACE_ROUTER_SOCKET);
    router.attach(server);
    process.on(
      "message",
      (message: { id: number; action: string; request: { resourceId?: string } }) => {
        if (message.action === "revoke-at-rendezvous") {
          server.prependOnceListener("upgrade", () => {
            sqlite
              .prepare("DELETE FROM workspaceAgentCredential WHERE resourceId=?")
              .run(message.request.resourceId);
          });
          process.send?.({ id: message.id, result: { armed: true } });
        }
      },
    );
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(3100, "127.0.0.1", done);
    });
    shutdown = async () => {
      releaseVendor();
      await stopWorkspaceRouter();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    };
  } else {
    const owner = new LiveCommunicationFileOwner();
    const mcpServer = new McpServer(
      { name: "separate-cloud", version: "1" },
      { capabilities: { tools: {} } },
    );
    registerTools(mcpServer, { agent: "chatgpt" }, () => null);
    const mcp = new Client({ name: "cloud-boundary", version: "1" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await mcp.connect(clientTransport);
    app.get(
      "/api/codespaces/files/:resourceId/:token",
      mcpLimiter,
      createWorkspacePublicationHandler({
        authorize: authorizeWorkspacePublication,
        workspace: getWorkspaceClient(),
      }),
    );
    const server = createHttpServer(app);
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(join(config.directory, "caller.sock"), done);
    });
    process.on(
      "message",
      (message: { id: number; action: string; request: Record<string, unknown> }) => {
        void (async () => {
          if (message.action === "tool")
            return runWithMCPContext({ userId: config.userId, agent: "chatgpt" }, () =>
              mcp.callTool({
                name: String(message.request.tool),
                arguments: message.request.request as Record<string, unknown>,
              }),
            );
          if (message.action === "submit")
            return owner.submit(
              config.userId,
              message.request as unknown as CommunicationOwnerSubmit,
            );
          if (message.action === "collect")
            return owner.collect(config.userId, String(message.request.requestId), {
              resourceId: String(message.request.resourceId),
            });
          throw new Error("Unknown fixture operation");
        })().then(
          (result) => process.send?.({ id: message.id, result }),
          (error) =>
            process.send?.({
              id: message.id,
              error: error instanceof Error ? error.message : "Operation refused",
            }),
        );
      },
    );
    shutdown = async () => {
      await mcp.close();
      await mcpServer.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    };
  }
  process.once("SIGTERM", () => {
    void shutdown().then(
      () => {
        closeDatabase();
        process.exit(0);
      },
      () => process.exit(1),
    );
  });
  process.send?.({ ready: true, pid: process.pid, database: sqlite.name });
}
