import { TelegramCommunicationAdapter } from "./telegram-communication-adapter.js";
import {
  CommunicationChannelRegistry,
  UserCommunicationService,
  type CommunicationChannelAdapter,
} from "./user-communication.js";

const activeCommunicationChannels = new CommunicationChannelRegistry([
  new TelegramCommunicationAdapter(),
]);
const activeUserCommunicationService = new UserCommunicationService(activeCommunicationChannels);

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
