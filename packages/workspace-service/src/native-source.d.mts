export interface NativeFileReference {
  fileId: string;
  downloadUrl: string;
  fileName?: string;
  mimeType?: string;
  declaredSize?: number;
}
export class SourceRefusal extends Error {
  publicCode: "SOURCE_REFUSED";
}
export function trustedNativeFileHost(host: string): boolean;
export function openNativeFile(
  reference: NativeFileReference,
  options?: {
    proxy?: string;
    signal?: AbortSignal;
  },
): Promise<{
  body: AsyncIterable<Uint8Array>;
  contentLength: number | null;
  mimeType: string;
  close(): Promise<void>;
  cancel(): void;
}>;
