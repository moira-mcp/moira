const { spawn } = require("node:child_process");
const { existsSync, watch } = require("node:fs");
const { publishFixtureFile } = require("./workspace-owner-signals.cjs");

function reportSurvival(trigger, effect, message, pidFile, resistTermination) {
  if (resistTermination) process.on("SIGTERM", () => {});
  watch(".", () => {
    if (existsSync(trigger) && !existsSync(effect)) publishFixtureFile(effect, message);
  });
  publishFixtureFile(pidFile, String(process.pid));
}

switch (process.argv[2]) {
  case "cancellation":
    reportSurvival("show-life", "after-cancel-effect", "still running", "actual-child", true);
    break;
  case "owner-loss":
    reportSurvival(
      "show-survival",
      "owner-loss-effect",
      "command survived owner loss",
      "owner-loss-child",
      false,
    );
    break;
  case "descendant":
    spawn(process.execPath, [__filename, "resist-cancellation"], { stdio: "ignore" });
    publishFixtureFile("cancellable-leader", "ready");
    break;
  case "resist-cancellation":
    reportSurvival(
      "show-descendant",
      "descendant-effect",
      "descendant survived cancellation",
      "resistant-descendant",
      true,
    );
    break;
  default:
    throw new Error("Unknown workspace owner fixture scenario");
}
setInterval(() => {}, 1000);
