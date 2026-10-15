import type { FileHandle } from "node:fs/promises";
import type { ServerResponse } from "node:http";

export type PublicationScope = (
  | {
      resourceId: string;
      resourceGeneration: number;
      authorizationGeneration: number;
    }
  | {
      kind: "controller";
      userId: string;
      deviceId: string;
      deviceGeneration: number;
      connectionId: string;
    }
) & { publicOrigin: string };

export type PublicationMetadata = {
  referenceId: string;
  uri: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  expiresAt: number;
};

export type PublicationInput = {
  path: string;
  fileName: string;
  mimeType?: string;
  maxBytes?: number;
  expiresInSeconds?: number;
};

export type PublicationSource = PublicationMetadata &
  AsyncIterable<Uint8Array> & {
    settled: Promise<void>;
    close(): Promise<void>;
  };

/** The supplier retains source/path identity through the callback's completed read. */
export type GuardedSourceReader = (
  path: string,
  read: (handle: FileHandle, size: number) => Promise<object>,
) => Promise<{ stat: { identity: object } }>;

export function createOwnerPublications(options: {
  stateRoot: string;
  scope?: PublicationScope;
  environmentIdentity: string;
  engine?: {
    withRegularFile: GuardedSourceReader;
    withFileCommitLock<T>(work: () => Promise<T>): Promise<T>;
  };
  withSource?: GuardedSourceReader;
  withCommitLock?<T>(work: () => Promise<T>): Promise<T>;
  now?: () => number;
}): Promise<{
  publish(input: PublicationInput): Promise<PublicationMetadata>;
  capture(
    input: Omit<PublicationInput, "path"> & {
      stream: AsyncIterable<Uint8Array>;
      sourceIdentity: object;
    },
  ): Promise<PublicationMetadata>;
  openSource(token: string, signal?: AbortSignal): Promise<PublicationSource>;
  serve(token: string, response: ServerResponse): Promise<void>;
  close(): Promise<void>;
}>;
