import { createServer, request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { BROKER_PREFACE } from "./broker-tunnel.js";

/** Built as a separate guest asset. The host reads its bytes, never imports or runs this entry. */
export async function serveGuestProxy(hostPort: number, authorization: string, guestPort = 3437) {
  if (!Number.isSafeInteger(hostPort) || hostPort < 1024 || hostPort > 65535)
    throw new Error("Invalid broker port");
  if (!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(authorization) || authorization.length >= 512)
    throw new Error("Invalid installed broker authorization");
  const peers = new Set<Socket>();
  const tunnel = (ready: (error: Error | null, socket?: Socket) => void) => {
    const socket = connect({ host: "host.docker.internal", port: hostPort });
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    let delivered = false;
    socket.once("error", (error) => {
      if (!delivered) ready(error);
    });
    socket.once("connect", () => {
      delivered = true;
      socket.write(BROKER_PREFACE);
      ready(null, socket);
    });
  };
  const server = createServer(
    { maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 120_000 },
    (request, response) => {
      const upstream = httpRequest(
        {
          method: request.method,
          path: request.url,
          host: "moira-local",
          headers: {
            ...request.headers,
            ...(request.url?.startsWith("http://") ? { "proxy-authorization": authorization } : {}),
            connection: "close",
          },
          createConnection: (_options, ready) => {
            tunnel((error, socket) => ready(error, socket!));
            return undefined;
          },
        },
        (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(response);
          reply.once("error", () => response.destroy());
        },
      );
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      response.once("close", () => upstream.destroy());
      request.once("aborted", () => upstream.destroy());
      request.pipe(upstream);
    },
  );
  server.on("connect", (request, client, head) => {
    const target = request.url ?? "";
    const destination = /^[a-z0-9.-]+:([0-9]{1,5})$/.exec(target);
    const targetPort = destination ? Number(destination[1]) : 0;
    if (!destination || targetPort < 1 || targetPort > 65535 || request.headers.origin) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    tunnel((error, upstream) => {
      if (error || !upstream || client.destroyed) {
        upstream?.destroy();
        client.destroy();
        return;
      }
      upstream.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${authorization}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      client.once("close", () => upstream.destroy());
      client.once("error", () => upstream.destroy());
      upstream.once("error", () => client.destroy());
      upstream.once("close", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(guestPort, "0.0.0.0", resolve);
  });
  return () => {
    for (const peer of peers) peer.destroy();
    server.close();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // This guest asset receives its fixed VM capability only from the local bootstrap child environment.
  // eslint-disable-next-line no-restricted-syntax
  await serveGuestProxy(Number(process.argv[2]), process.env.MOIRA_LOCAL_PROXY_AUTHORIZATION ?? "");
}
