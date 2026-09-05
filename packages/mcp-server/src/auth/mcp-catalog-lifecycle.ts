import {
  isInitializeRequest,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type InitializeRequest,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";

interface RevisionAwareTransport {
  send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }): Promise<void>;
}

export type CatalogInitializeRequest = InitializeRequest & { jsonrpc: "2.0"; id: RequestId };

export function getCatalogInitializeRequest(body: unknown): CatalogInitializeRequest | null {
  if (Array.isArray(body) || !isJSONRPCRequest(body) || !isInitializeRequest(body)) return null;
  return body as CatalogInitializeRequest;
}

export function requireRevisionStampBeforeInitializeResult(
  transport: RevisionAwareTransport,
  request: CatalogInitializeRequest,
  stampRevision: () => Promise<boolean>,
): void {
  const send = transport.send.bind(transport);
  let stampPromise: Promise<boolean> | undefined;

  transport.send = async (message, options) => {
    if (isJSONRPCResultResponse(message) && message.id === request.id) {
      stampPromise ??= stampRevision();
      if (!(await stampPromise)) {
        throw new Error("Authenticated credential became invalid before catalog initialization");
      }
    }
    await send(message, options);
  };
}
