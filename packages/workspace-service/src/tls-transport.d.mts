import type { TLSSocket } from "node:tls";
export function transportClosed(socket: import("node:stream").Duplex): Promise<void>;
export function validatedInstalledProxy(value: string): URL;
export function connectHttps(options: {
  hostname: string;
  port?: number;
  proxy?: string;
  signal?: AbortSignal;
  publicTarget?: boolean;
}): Promise<TLSSocket>;
