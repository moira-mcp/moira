import type { Dispatcher1Wrapper } from "undici";

let dispatcher: Promise<Dispatcher1Wrapper> | undefined;

/** Work waits for its owner or caller abort; connection establishment keeps Undici's defaults. */
export async function fetchWork(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
  // Node's built-in fetch uses the v1 dispatcher handler contract.
  // Keep this Node-only dependency out of consumers that import shared presentation code.
  dispatcher ??= import("undici").then(
    ({ Agent, Dispatcher1Wrapper }) =>
      new Dispatcher1Wrapper(new Agent({ headersTimeout: 0, bodyTimeout: 0 })),
  );
  const options: RequestInit & { dispatcher: Dispatcher1Wrapper } = {
    ...init,
    dispatcher: await dispatcher,
  };
  return fetchImpl(input, options);
}
