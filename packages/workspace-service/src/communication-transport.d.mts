import type { OwnerCommunicationTransport } from "./owner-communication.mjs";
import type { CommunicationOwnerScope } from "../../shared/src/communication-owner-protocol.js";
export function createOwnerCommunicationTransport(options: {
  origin: string;
  credential: string;
  proxy?: string;
}): OwnerCommunicationTransport & {
  artifact(
    channelId: string,
    digest: string,
    scope: CommunicationOwnerScope,
    signal?: AbortSignal,
  ): Promise<{ digest: string; bytes: Uint8Array }>;
};
