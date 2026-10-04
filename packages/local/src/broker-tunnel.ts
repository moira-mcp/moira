import { connect, createServer, type Socket } from "node:net";

export const BROKER_PREFACE = "MOIRA-LOCAL/1\n";

/** Fixed-service framing keeps the sandbox's transparent TCP path distinct from its HTTP proxy. */
export async function startBrokerTunnel(targetPort: number, port = 0) {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.on("error", () => client.destroy());
    client.once("close", () => sockets.delete(client));
    client.setTimeout(5000, () => client.destroy());
    let prefix = Buffer.alloc(0);
    const initial = (chunk: Buffer) => {
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.length < Buffer.byteLength(BROKER_PREFACE)) return;
      client.removeListener("data", initial);
      client.pause();
      if (!prefix.subarray(0, Buffer.byteLength(BROKER_PREFACE)).equals(Buffer.from(BROKER_PREFACE)) || prefix.length > 64 * 1024) {
        client.destroy();
        return;
      }
      // This destination is captured from our own HTTP listener, never supplied by a client.
      const upstream = connect({ host: "127.0.0.1", port: targetPort });
      sockets.add(upstream);
      upstream.once("close", () => { sockets.delete(upstream); client.destroy(); });
      upstream.once("error", () => client.destroy());
      client.once("close", () => upstream.destroy());
      upstream.once("connect", () => {
        client.setTimeout(125_000, () => client.destroy());
        const remainder = prefix.subarray(Buffer.byteLength(BROKER_PREFACE));
        if (remainder.length) upstream.write(remainder);
        prefix = Buffer.alloc(0);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    };
    client.on("data", initial);
  });
  server.maxConnections = 128;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Broker tunnel did not bind");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
