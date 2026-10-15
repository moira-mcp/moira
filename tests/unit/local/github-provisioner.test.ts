import { describe, expect, test } from "@jest/globals";
import { validateGitHubSshConfig } from "../../../packages/local/src/github-provisioner.js";

const home = "/tmp/moira-gh-owned",
  gh = `${home}/gh`,
  resource = "owned-codespace";
const generated = `Host cs.${resource}.feature-branch
  User codespace
  ProxyCommand ${gh} cs ssh -c ${resource} --stdio -- -i ${home}/.ssh/codespaces.auto
  UserKnownHostsFile=/dev/null
  StrictHostKeyChecking no
  LogLevel quiet
  ControlMaster auto
  IdentityFile ${home}/.ssh/codespaces.auto
`;
describe("fixed GitHub provisioning configuration", () => {
  test("the pinned CLI configuration retains exactly the owned resource, key and executable", () => {
    expect(validateGitHubSshConfig(generated, gh, home, resource)).toBe(
      `cs.${resource}.feature-branch`,
    );
  });
  test.each([
    generated + "User root\n",
    generated + "LocalCommand touch /tmp/unowned\n",
    generated.replace(`${gh} cs ssh`, "/project/gh cs ssh"),
    generated.replace("--stdio -- -i", "--stdio -- -o ProxyCommand=unowned -i"),
    generated.replace("Host cs.owned-codespace", "Host cs.foreign-codespace"),
    generated.replace(`IdentityFile ${home}`, "IdentityFile /project"),
  ])("foreign or overriding SSH configuration refuses before execution", (configuration) => {
    expect(() => validateGitHubSshConfig(configuration, gh, home, resource)).toThrow();
  });
});
