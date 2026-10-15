export interface NativeFileReference {
  fileId: string;
  downloadUrl: string;
  fileName?: string;
  mimeType?: string;
  declaredSize?: number;
}
export class SourceRefusal extends Error {
  publicCode: "SOURCE_REFUSED";
  status: 422;
}
export type NativeFileIdentity = Omit<NativeFileReference, "downloadUrl">;
export function nativeFileIdentity(reference: unknown): NativeFileIdentity;
export interface NativeFileSource {
  body: AsyncIterable<Uint8Array>;
  contentLength: number | null;
  mimeType?: string;
  close(): Promise<void>;
  cancel?(): void;
  settled?: Promise<void>;
}
export type NativeFileOpener = (
  reference: NativeFileReference,
  options?: { proxy?: string; signal?: AbortSignal },
) => Promise<NativeFileSource>;
export type NativeFileBytes = NativeFileSource & {
  mimeType: string;
  cancel(): void;
  settled: Promise<void>;
};
export function nativeFileBytes(
  reference: NativeFileReference,
  options?: { sourceOpener?: NativeFileOpener; proxy?: string; signal?: AbortSignal },
): Promise<NativeFileBytes>;
export function trustedNativeFileHost(host: string): boolean;
export function openNativeFile(
  reference: NativeFileReference,
  options?: {
    proxy?: string;
    signal?: AbortSignal;
  },
): Promise<NativeFileBytes>;
