import type {
  CommunicationOwnerScope,
  CommunicationOwnerPrepare,
  CommunicationOwnerSend,
  CommunicationOwnerReceipt,
  MaterializeTextFile,
} from "../../shared/src/communication-owner-protocol.js";
import type { PublicationSource, createOwnerPublications } from "./publications.mjs";
export interface OwnerCommunicationTransport {
  prepare(input: CommunicationOwnerPrepare, signal?: AbortSignal): Promise<unknown>;
  send(
    input: CommunicationOwnerSend,
    source: PublicationSource,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export type OwnerCommunicationReceipt = CommunicationOwnerReceipt;
export type MaterializeOwnedSource = AsyncIterable<Uint8Array> & {
  close(): Promise<void>;
  settled: Promise<void>;
};
export type OwnerCommunicationConfiguration = {
  scope?: CommunicationOwnerScope;
  transport?: OwnerCommunicationTransport;
  extensionArtifact?: (
    channelId: string,
    digest: string,
    scope: CommunicationOwnerScope,
    signal?: AbortSignal,
  ) => Promise<{ digest: string; bytes: Uint8Array }>;
};
export function createOwnerCommunication(
  options: OwnerCommunicationConfiguration & {
    stateRoot: string;
    publications: Awaited<ReturnType<typeof createOwnerPublications>>;
    sourceProxy?: string;
    sourceOpener?: import("./native-source.mjs").NativeFileOpener;
    renderProgress?: (
      descriptor: unknown,
      options: { signal?: AbortSignal; cacheRoot?: string },
    ) => Promise<Uint8Array>;
    renderMaterialize?: (
      files: MaterializeTextFile[],
      options: { signal?: AbortSignal },
    ) => Promise<MaterializeOwnedSource>;
    deliverExtension?: typeof import("./extension-owner.mjs").deliverOwnerExtension;
    handlerHost?: string;
    extensionHelperPath?: string;
    admit?: (
      requestId: string,
      inputDigest: string,
      work: () => Promise<OwnerCommunicationReceipt>,
    ) => Promise<unknown>;
  },
): Promise<{
  configure(configuration?: OwnerCommunicationConfiguration): void;
  submit(
    input: unknown,
    options?: { stream?: AsyncIterable<Uint8Array> },
  ): Promise<OwnerCommunicationReceipt>;
  inspect(requestId: string): Promise<OwnerCommunicationReceipt>;
  close(): Promise<void>;
}>;
