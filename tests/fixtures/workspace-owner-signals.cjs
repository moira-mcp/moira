const { writeFileSync, renameSync } = require("node:fs");
const { join } = require("node:path");

// Watchers must see either no marker or its complete value, including the PID.
function publishFixtureFile(path, value) {
  writeFileSync(path + ".pending", value);
  renameSync(path + ".pending", path);
}

const action = process.env.MOIRA_TEST_OWNER_EVENT;
const directory = process.env.MOIRA_TEST_OWNER_DIRECTORY;
if (process.send && directory && (action === "drop-start" || action === "observe-close")) {
  const send = process.send.bind(process);
  process.send = (message, ...args) => {
    if (action === "drop-start" && Number.isSafeInteger(message?.startedAt)) {
      publishFixtureFile(join(directory, "unacknowledged-owner"), String(process.pid));
      return true;
    }
    if (action === "observe-close" && Object.hasOwn(message, "exitCode")) {
      const callback = typeof args.at(-1) === "function" ? args.pop() : undefined;
      return send(message, ...args, (error) => {
        publishFixtureFile(join(directory, "command-close-owner"), String(process.pid));
        callback?.(error);
      });
    }
    return send(message, ...args);
  };
}

module.exports = { publishFixtureFile };
