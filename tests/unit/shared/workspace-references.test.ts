import { expect, test } from "@jest/globals";
import {
  decodeReference,
  encodeReference,
  isReference,
} from "../../../packages/shared/src/codespaces/workspace-references.js";

const owner = {
  kind: "local" as const,
  deviceId: "11111111-1111-4111-8111-111111111111",
  spaceId: "22222222-2222-4222-8222-222222222222",
  operationMarker: `moira-${"a".repeat(24)}`,
};

test("returned file and continuation references preserve Unicode and the complete observed identity", () => {
  const observed = {
    owner,
    binding: "b".repeat(64),
    path: "история/Мира 🚣.txt",
    version: { size: 17, sha256: "c".repeat(64) },
    identity: {
      dev: "1",
      ino: "42",
      nlink: "1",
      size: "17",
      mtimeNs: "12000000001",
      ctimeNs: "12000000002",
    },
  };
  const file = encodeReference("file", observed);
  const cursor = encodeReference("file-cursor", { file, offset: 12, line: 2 });
  expect(decodeReference(decodeReference(cursor, "file-cursor").file, "file")).toEqual(observed);
  expect(
    encodeReference("file", {
      ...observed,
      owner: {
        operationMarker: owner.operationMarker,
        spaceId: owner.spaceId,
        deviceId: owner.deviceId,
        kind: "local",
      },
    }),
  ).toBe(file);
  expect(
    encodeReference("file", { ...observed, identity: { ...observed.identity, ino: "43" } }),
  ).not.toBe(file);
});

test("reference decoding rejects foreign purposes, extra credential data and noncanonical payloads", () => {
  const operation = encodeReference("operation", {
    owner,
    requestId: "ws1-33333333-3333-4333-8333-333333333333",
    kind: "command",
  });
  expect(isReference(operation, "workspace")).toBe(false);
  expect(() =>
    encodeReference("operation", {
      owner: { ...owner, credential: "must-not-be-encoded" },
      requestId: "ws1-33333333-3333-4333-8333-333333333333",
      kind: "command",
    } as never),
  ).toThrow("INVALID_WORKSPACE_REFERENCE");
  const payload = Buffer.from(
    JSON.stringify(decodeReference(operation, "operation"), null, 2),
  ).toString("base64url");
  expect(isReference(`moira-operation:v1:${payload}`)).toBe(false);
  expect(isReference(`${operation}=`)).toBe(false);
});
