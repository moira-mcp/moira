import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";

const execute = promisify(execFile);

/** Invoked inside the VM only; its Docker daemon and configuration belong to that VM. */
export async function configureGuestDocker(
  proxyUrl: string,
  spaceId: string,
  token: string,
): Promise<void> {
  const directory = join(homedir(), ".local", "share", "moira-local");
  let configuration: Record<string, unknown> = {};
  try {
    const { stdout } = await execute("sudo", ["-n", "cat", "/etc/docker/daemon.json"], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("Invalid guest Docker configuration");
    configuration = parsed as Record<string, unknown>;
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.includes("No such file or directory")
    ))
      throw error;
  }
  const previousProxies = configuration.proxies as Record<string, unknown> | undefined;
  const previouslyExact =
    previousProxies?.["http-proxy"] === proxyUrl &&
    previousProxies?.["https-proxy"] === proxyUrl &&
    previousProxies?.["no-proxy"] === "localhost,127.0.0.1,::1";
  configuration.proxies = {
    "http-proxy": proxyUrl,
    "https-proxy": proxyUrl,
    "no-proxy": "localhost,127.0.0.1,::1",
  };
  const prepared = join(directory, "daemon.json");
  await writeFile(prepared, JSON.stringify(configuration), { mode: 0o600 });
  await execute("sudo", ["-n", "install", "-D", "-m", "600", prepared, "/etc/docker/daemon.json"], {
    timeout: 10_000,
  });
  const installed = JSON.parse(
    (
      await execute("sudo", ["-n", "cat", "/etc/docker/daemon.json"], {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      })
    ).stdout,
  );
  if (
    installed?.proxies?.["http-proxy"] !== proxyUrl ||
    installed?.proxies?.["https-proxy"] !== proxyUrl ||
    installed?.proxies?.["no-proxy"] !== "localhost,127.0.0.1,::1"
  )
    throw new Error("Guest Docker proxy configuration was not installed exactly");
  // Engine SystemInfo masks both userinfo fields with this fixed literal.
  // Compare the complete URL pair, preserving every other field and both protocols.
  const maskedProxy = proxyUrl.replace(/^([^:]+:\/\/)[^/?#]*@/, "$1xxxxx:xxxxx@");
  const matchesProxy = (output: string) =>
    output.trim() === `${proxyUrl}|${proxyUrl}` ||
    output.trim() === `${maskedProxy}|${maskedProxy}`;
  let configured = false;
  try {
    const { stdout } = await execute(
      "docker",
      ["info", "--format", "{{.HTTPProxy}}|{{.HTTPSProxy}}"],
      { timeout: 10_000 },
    );
    configured = previouslyExact && matchesProxy(stdout);
  } catch {
    /* A new VM may not have started its own Docker daemon yet. */
  }
  if (!configured)
    // The template init script lowers hard NOFILE to 524288. Its inherited soft
    // limit must not exceed that value; leave the hard ceiling unchanged here.
    await execute(
      "sudo",
      ["-n", "prlimit", "--nofile=524288:", "--", "service", "docker", "restart"],
      {
        timeout: 30_000,
        maxBuffer: 128 * 1024,
      },
    );
  for (let attempt = 0; attempt < 20 && !configured; attempt++) {
    try {
      const { stdout } = await execute(
        "docker",
        ["info", "--format", "{{.HTTPProxy}}|{{.HTTPSProxy}}"],
        { timeout: 5000 },
      );
      configured = matchesProxy(stdout);
    } catch {
      /* Wait for this guest's daemon, not a host socket. */
    }
    if (!configured) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!configured) throw new Error("Guest Docker did not adopt its restricted proxy");
  const { stdout } = await execute(
    "docker",
    ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"],
    { timeout: 10_000 },
  );
  const gateway = stdout.trim();
  if (isIP(gateway) !== 4) throw new Error("Guest Docker bridge is unavailable");
  const clientDirectory = join(homedir(), ".docker");
  await mkdir(clientDirectory, { recursive: true, mode: 0o700 });
  let client: Record<string, unknown> = {};
  try {
    client = JSON.parse(await readFile(join(clientDirectory, "config.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!client || typeof client !== "object" || Array.isArray(client))
    throw new Error("Invalid guest Docker client configuration");
  const proxy = `http://${spaceId}:${token}@${gateway}:3437`;
  client.proxies = {
    default: { httpProxy: proxy, httpsProxy: proxy, noProxy: "localhost,127.0.0.1,::1" },
  };
  await writeFile(join(clientDirectory, "config.json"), JSON.stringify(client), { mode: 0o600 });
}
