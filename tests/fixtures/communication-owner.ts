import type { CommunicationOwnerSubmit } from "@mcp-moira/shared";
import type { CommunicationFileOwner } from "@mcp-moira/workflow-engine";

export const communicationDeviceId = "620b1509-24ea-48d4-a73e-063fae51e166";

/** Controlled file-owner boundary; rendering/source behavior is exercised by owner runtime tests. */
export function communicationOwnerFixture(
  beforeSubmit?: (input: CommunicationOwnerSubmit) => void | Promise<void>,
) {
  const submitted: CommunicationOwnerSubmit[] = [];
  const selected: Array<{ userId: string; deviceId?: string }> = [];
  const file = {
    referenceId: `owner-file://controller/${communicationDeviceId}/${"a".repeat(43)}`,
    uri: `https://moira.test/api/communication/files/${communicationDeviceId}/${"a".repeat(43)}`,
    fileName: "progress.png",
    mimeType: "image/png",
    size: 3,
    sha256: "a".repeat(64),
    expiresAt: Date.now() + 60000,
  };
  const owner: CommunicationFileOwner = {
    async select(userId, deviceId) {
      selected.push({ userId, deviceId });
      return {
        kind: "controller",
        userId,
        deviceId: deviceId ?? communicationDeviceId,
        deviceGeneration: 1,
        connectionId: "620b1509-24ea-48d4-a73e-063fae51e167",
      };
    },
    async submit(_userId, input) {
      submitted.push(input);
      await beforeSubmit?.(input);
      return {
        requestId: input.requestId,
        state: "completed",
        device_id: communicationDeviceId,
        outcome: {
          ok: true,
          result: {
            file,
            ...(input.action === "deliver"
              ? { status: "delivered", channels: [{ channelId: "telegram", status: "delivered" }] }
              : {}),
          },
        },
      };
    },
    async collect(_userId, requestId) {
      return { requestId, state: "absent" };
    },
    async openPublication() {
      return {
        headers: { "content-type": "image/png" },
        body: (async function* () {
          yield Uint8Array.of(1, 2, 3);
        })(),
      };
    },
  };
  return { owner, submitted, selected, file };
}
