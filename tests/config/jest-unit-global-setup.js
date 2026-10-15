import { buildLocalNativeHelpers } from "../../scripts/build-local-native.js";

export default async function globalSetup() {
  // Unit tests exercise real private-state locks and process custody in fresh checkouts.
  await buildLocalNativeHelpers();
}
