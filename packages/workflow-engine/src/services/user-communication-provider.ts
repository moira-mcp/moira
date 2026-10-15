import { TelegramCommunicationAdapter } from "./telegram-communication-adapter.js";
import {
  AppError,
  type CommunicationOwnerScope,
  type CommunicationOwnerSubmit,
} from "@mcp-moira/shared";
import {
  CommunicationChannelRegistry,
  UserCommunicationService,
  type CommunicationChannelAdapter,
} from "./user-communication.js";

const activeCommunicationChannels = new CommunicationChannelRegistry([
  new TelegramCommunicationAdapter(),
]);
const activeUserCommunicationService = new UserCommunicationService(activeCommunicationChannels);

/** Installed by the application edge; the workflow engine never imports a backend transport. */
export interface CommunicationFileOwner {
  select(
    userId: string,
    deviceId?: string,
  ): Promise<Extract<CommunicationOwnerScope, { kind?: "controller" }>>;
  submit(
    userId: string,
    input: CommunicationOwnerSubmit,
    deviceId?: string,
  ): Promise<Record<string, unknown>>;
  collect(
    userId: string,
    requestId: string,
    owner: { deviceId?: string; resourceId?: string },
  ): Promise<Record<string, unknown>>;
  openPublication(
    userId: string,
    referenceId: string,
  ): Promise<{
    headers: Record<string, string | string[] | undefined>;
    body: AsyncIterable<Uint8Array>;
  }>;
}
let fileOwner: CommunicationFileOwner | undefined;
export function setActiveCommunicationFileOwner(owner: CommunicationFileOwner): void {
  fileOwner = owner;
}
export function getActiveCommunicationFileOwner(): CommunicationFileOwner {
  if (!fileOwner) throw new CommunicationChannelOwnerUnavailableError();
  return fileOwner;
}
export class CommunicationChannelOwnerUnavailableError extends AppError {
  readonly code = "COMMUNICATION_OWNER_UNAVAILABLE";
  readonly isOperational = true;
  constructor() {
    super(
      "The selected file owner is unavailable. Connect the paired controller and select its device if more than one controller is available.",
    );
  }
  get statusCode(): number {
    return 503;
  }
}

export function getActiveCommunicationChannelRegistry(): CommunicationChannelRegistry {
  return activeCommunicationChannels;
}

export function getActiveUserCommunicationService(): UserCommunicationService {
  return activeUserCommunicationService;
}

export function registerActiveCommunicationChannel(adapter: CommunicationChannelAdapter): void {
  activeCommunicationChannels.register(adapter);
}

export function unregisterActiveCommunicationChannel(channelId: string): boolean {
  if (channelId === "telegram") throw new Error("The built-in Telegram channel cannot be removed");
  return activeCommunicationChannels.unregister(channelId);
}
