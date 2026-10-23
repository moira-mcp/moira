import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entry = pathToFileURL(resolve("packages/workflow-cli/bin/moira-workflow.js")).href;
let child: EventEmitter;

beforeEach(() => {
  jest.resetModules();
  child = new EventEmitter();
  jest.unstable_mockModule("node:child_process", () => ({ spawn: () => child }));
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.unstable_unmockModule("node:child_process");
});

test("a terminated CLI child forwards its signal instead of reporting success", async () => {
  const kill = jest.spyOn(process, "kill").mockReturnValue(true);
  const exit = jest.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("Unexpected adapter exit");
  });
  await import(entry);

  child.emit("exit", null, "SIGTERM");

  expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
  expect(exit).not.toHaveBeenCalled();
});

test.each([0, 7])("the adapter preserves the child's exit code %i", async (code) => {
  const kill = jest.spyOn(process, "kill").mockReturnValue(true);
  const exit = jest.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("Adapter exit");
  });
  await import(entry);

  expect(() => child.emit("exit", code, null)).toThrow("Adapter exit");

  expect(exit).toHaveBeenCalledWith(code);
  expect(kill).not.toHaveBeenCalled();
});
