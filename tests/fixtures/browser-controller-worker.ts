/** Private child: its CA trust and Local state never affect the browser test process. */
import { createInterface } from "node:readline";
import { controllerFixture } from "./local-controller.js";
import { startWorkspaceRemote } from "../../packages/workspace-service/src/remote.js";
import { localConnectionSchema } from "../../packages/local/src/relay.js";

const input = createInterface({ input: process.stdin });
const iterator = input[Symbol.asyncIterator]();
const first = await iterator.next();
if (first.done) throw new Error("Browser controller configuration absent");
const config = JSON.parse(first.value);
const connection = localConnectionSchema.parse(config.connection);
if (!connection.userId || !connection.deviceGeneration || !connection.connectionId)
  throw new Error("Confirmed browser controller identity required");
const owner = await controllerFixture(config.directory, {
  userId: connection.userId,
  deviceId: connection.deviceId,
  deviceGeneration: connection.deviceGeneration,
  connectionId: connection.connectionId,
});
const refused = () => {
  throw new Error("Browser publication fixture cannot open a native VM");
};
owner.manager.dependencies.runtime = refused;
owner.manager.dependencies.guard = refused;
owner.manager.dependencies.storage = refused;
await owner.state.write("connection.json", connection);
const remote = startWorkspaceRemote({
  kind: "controller",
  socketPath: owner.endpoint.socketPath,
  origin: connection.origin,
  credential: connection.credential,
  connectionId: connection.connectionId,
});
try {
  await remote.whenConnected();
  process.stdout.write("browser-controller-ready\n");
  await iterator.next();
} finally {
  await remote.close();
  await owner.close();
  input.close();
}
