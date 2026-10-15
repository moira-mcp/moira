export interface OwnerExtensionSource {
  metadata: {
    kind: "image" | "document";
    filename: string;
    mimeType: string;
    size: number;
    sha256: string;
  };
  open(
    signal?: AbortSignal,
  ): Promise<{ stream: AsyncIterable<Uint8Array>; close(): Promise<void>; settled: Promise<void> }>;
}
export function deliverOwnerExtension(options: {
  artifact: { digest: string; bytes: Uint8Array };
  directory: string;
  handlerHost: string;
  helperPath?: string;
  channelId: string;
  source: OwnerExtensionSource;
  message: { text: string; format?: "plain" | "markdown" | "html"; silent?: boolean };
  settings: Record<string, unknown>;
  signal?: AbortSignal;
  send(
    operationId: string,
    controls: { caption?: string; format?: "plain" | "markdown" | "html"; silent?: boolean },
    signal: AbortSignal,
  ): Promise<unknown>;
}): Promise<void>;
