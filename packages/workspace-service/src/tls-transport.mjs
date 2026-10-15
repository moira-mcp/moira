import { request } from "node:http";
import { lookup } from "node:dns/promises";
import { connect } from "node:tls";
import { isIP } from "node:net";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { publicAddress } from "./public-address.mjs";

const refused = () => new Error("TLS transport refused");
/** Error is not close: custody remains held until the actual transport close event. */
export function transportClosed(socket) {
  return socket.closed
    ? Promise.resolve()
    : new Promise((resolve) => socket.once("close", resolve));
}

/** The installed Local gateway is authority, never a caller-selected generic proxy. */
export function validatedInstalledProxy(value) {
  try {
    const proxy = new URL(value);
    if (
      proxy.protocol !== "http:" ||
      proxy.hostname !== "127.0.0.1" ||
      proxy.port !== "3437" ||
      !proxy.username ||
      !proxy.password ||
      proxy.pathname !== "/" ||
      proxy.search ||
      proxy.hash
    )
      throw refused();
    decodeURIComponent(proxy.username);
    decodeURIComponent(proxy.password);
    return proxy;
  } catch {
    throw refused();
  }
}

/** Hostname-verified TLS, either direct or through the verified Local CONNECT gateway. */
export async function connectHttps({ hostname, port = 443, proxy, signal, publicTarget = false }) {
  if (signal?.aborted) throw refused();
  let selected;
  // Local DNS/peer admission belongs to the broker, not this guest's loopback socket.
  if (proxy === undefined && publicTarget) {
    try {
      let detach = () => {};
      const cancelled = new Promise((_, reject) => {
        if (!signal) return;
        const abort = () => reject(refused());
        signal.addEventListener("abort", abort, { once: true });
        detach = () => signal.removeEventListener("abort", abort);
      });
      let answers;
      try {
        answers = await Promise.race([lookup(hostname, { all: true, verbatim: true }), cancelled]);
      } finally {
        detach();
      }
      if (
        !answers.length ||
        answers.some(({ address, family }) => !publicAddress(address) || isIP(address) !== family)
      )
        throw refused();
      selected = answers[0];
    } catch {
      throw refused();
    }
  }
  if (signal?.aborted) throw refused();
  const gateway = proxy === undefined ? undefined : validatedInstalledProxy(proxy);
  return new Promise((resolve, reject) => {
    let tunnel;
    let socket;
    let admission;
    let finished = false;
    const detach = () => signal?.removeEventListener("abort", abort);
    const fail = () => {
      admission?.destroy();
      tunnel?.destroy();
      socket?.destroy();
      if (!finished) {
        finished = true;
        detach();
        reject(refused());
      }
    };
    const abort = () => fail();
    signal?.addEventListener("abort", abort, { once: true });
    const secure = () => {
      socket = connect({
        rejectUnauthorized: true,
        host: selected?.address ?? hostname,
        port,
        ...(selected ? { family: selected.family } : {}),
        ...(isIP(hostname) ? {} : { servername: hostname }),
        ALPNProtocols: ["http/1.1"],
        ...(tunnel ? { socket: tunnel } : {}),
      });
      socket.once("error", fail);
      socket.once("close", detach);
      socket.once("secureConnect", () => {
        const peer = socket.remoteAddress;
        if (selected && peer !== selected.address && peer !== `::ffff:${selected.address}`)
          return fail();
        if (signal?.aborted) return fail();
        finished = true;
        resolve(socket);
      });
    };
    if (!gateway) return secure();
    admission = request({
      host: gateway.hostname,
      port: Number(gateway.port),
      method: "CONNECT",
      path: `${hostname}:${port}`,
      agent: false,
      headers: {
        "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(gateway.username)}:${decodeURIComponent(gateway.password)}`).toString("base64")}`,
      },
    });
    admission.once("error", fail);
    admission.once("response", (response) => {
      response.destroy();
      fail();
    });
    admission.once("connect", (response, connected, head) => {
      tunnel = connected;
      tunnel.once("error", fail);
      if (response.statusCode !== 200 || head.length || signal?.aborted) return fail();
      secure();
    });
    admission.end();
  });
}
