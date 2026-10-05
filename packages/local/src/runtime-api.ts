import { lstat, realpath } from "node:fs/promises";
import { request } from "node:http";
import type { Socket } from "node:net";
import type { Writable } from "node:stream";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { LocalRefusal, localPolicySchema, MAX_MESSAGE_BYTES } from "./policy.js";
import { containerIdentitySchema, type ContainerIdentity } from "./sbx-runtime.js";
import {
  GUEST_INSTALL_COMMAND,
  GUEST_WORKER_COMMAND,
  VERIFIED_GUEST_FAILURE_EXIT,
} from "./assets.js";

const MAX_RESPONSE_BYTES = 64 * 1024;

async function ownedSocket(
  home: string,
  namespace: string,
  name: string,
  peerName: "sandboxd.sock" | "docker.sock" = "sandboxd.sock",
): Promise<string> {
  const refusal = () =>
    new LocalRefusal("LOCAL_RUNTIME_API_UNSAFE", "The private SDK startup endpoint is unsafe.");
  if (!/^moira-[a-f0-9]{14}$/.test(namespace) || !/^moira-[a-f0-9]{32}$/.test(name))
    throw refusal();
  const root = await realpath(home);
  const metadata = await lstat(home);
  if (
    root !== home ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid())
  )
    throw refusal();
  const socket = join(home, ".sbx", `run_${namespace}`, "d", peerName);
  const target = await realpath(socket);
  const peer = await lstat(target);
  if (
    !target.startsWith(`${home}${sep}`) ||
    !peer.isSocket() ||
    peer.nlink !== 1 ||
    (process.getuid && peer.uid !== process.getuid())
  )
    throw refusal();
  return socket;
}

function call(
  socket: string,
  method: "DELETE" | "POST" | "GET",
  path: string,
  expected: number,
  body?: string,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const operation = request(
      {
        socketPath: socket,
        method,
        path,
        agent: false,
        signal,
        timeout: timeoutMs,
        maxHeaderSize: 8192,
        headers: {
          connection: "close",
          ...(body
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
              }
            : {}),
        },
      },
      (response) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= MAX_RESPONSE_BYTES) chunks.push(Buffer.from(chunk));
          if (bytes > MAX_RESPONSE_BYTES)
            response.destroy(
              new LocalRefusal(
                "LOCAL_OUTPUT_LIMIT",
                "The SDK startup response exceeded its bound.",
              ),
            );
        });
        response.once("error", reject);
        response.once("end", () => {
          if (response.statusCode !== expected)
            reject(new LocalRefusal("LOCAL_RUNTIME_API_REFUSED", "The SDK refused safe startup."));
          else resolve(Buffer.concat(chunks));
        });
      },
    );
    operation.once("error", reject);
    operation.once("timeout", () =>
      operation.destroy(
        new LocalRefusal("LOCAL_COMMAND_TIMEOUT", "The SDK startup did not settle."),
      ),
    );
    operation.end(body);
  });
}

/** The pinned local SDK API starts a VM without the CLI re-creating its host MCP gateway. */
export async function startWithoutGateway(
  home: string,
  namespace: string,
  name: string,
  gatewayPresent: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const socket = await ownedSocket(home, namespace, name);
  if (gatewayPresent)
    await call(socket, "DELETE", `/sandbox/${name}/mcp/gateway`, 204, undefined, signal);
  await call(socket, "POST", `/sandbox/${name}/start`, 200, "{}", signal);
}

const createProfile = localPolicySchema
  .innerType()
  .shape.runtime.pick({
    template: true,
    cpuCores: true,
    memoryBytes: true,
    dockerBytes: true,
  })
  .extend({ name: z.string().regex(/^moira-[a-f0-9]{32}$/) })
  .strict();
type CreateProfile = z.infer<typeof createProfile>;
const createdResponse = z
  .object({
    name: z.string(),
    agent: z.literal("shell"),
    workspace: z.literal(""),
    withheld: z.array(z.unknown()).optional(),
    worktree: z.unknown().optional(),
  })
  .passthrough();

/** Only locally bounded shell creation is exposed; no CLI MCP reservation or startup hooks. */
export async function createWithoutGateway(
  home: string,
  namespace: string,
  input: CreateProfile,
  signal?: AbortSignal,
): Promise<{ name: string; agent: "shell"; workspace: "" }> {
  const profile = createProfile.parse(input);
  const socket = await ownedSocket(home, namespace, profile.name);
  const bytes = await call(
    socket,
    "POST",
    "/sandbox",
    201,
    JSON.stringify({
      agent: "shell",
      name: profile.name,
      template: profile.template,
      cpus: profile.cpuCores,
      memory: `${profile.memoryBytes / 1024 ** 2}m`,
      dind_volume_size: `${profile.dockerBytes / 1024 ** 2}m`,
      skills: "off",
      workspace: "",
      additional_workspaces: [],
      credential_values: [],
      environment: {},
      kits: [],
      ssh_agent_socket_path: "",
      clone: false,
      display: false,
      gpu: false,
      nested: false,
      usb_devices: [],
    }),
    signal,
    10 * 60_000,
  );
  const response = createdResponse.parse(JSON.parse(bytes.toString("utf8")));
  if (
    response.name !== profile.name ||
    response.withheld?.length ||
    response.worktree !== undefined
  )
    throw new LocalRefusal(
      "LOCAL_CREATE_UNKNOWN",
      "The SDK did not confirm the approved empty shell profile.",
    );
  return { name: response.name, agent: response.agent, workspace: response.workspace };
}

/** This reads only the dedicated SDK Engine's one labeled container, never a user's Docker socket. */
export async function readContainerIdentity(
  home: string,
  namespace: string,
  name: string,
  signal?: AbortSignal,
): Promise<ContainerIdentity> {
  const socket = await ownedSocket(home, namespace, name, "docker.sock");
  const filters = encodeURIComponent(
    JSON.stringify({ label: [`com.docker.sandbox.name=${name}`] }),
  );
  const bytes = await call(
    socket,
    "GET",
    `/containers/json?all=true&filters=${filters}`,
    200,
    undefined,
    signal,
  );
  const rows = z
    .array(
      z
        .object({
          Id: containerIdentitySchema.shape.containerId,
          Names: z.tuple([z.literal(`/${name}`)]),
          Labels: z
            .object({
              "com.docker.sandbox.name": z.literal(name),
              "com.docker.sdk": z.literal("true"),
              "docker/sandbox": z.literal("true"),
            })
            .passthrough(),
          State: containerIdentitySchema.shape.state,
        })
        .passthrough(),
    )
    .length(1)
    .parse(JSON.parse(bytes.toString("utf8")));
  return containerIdentitySchema.parse({ containerId: rows[0].Id, name, state: rows[0].State });
}

type GuestMode = "installer" | "worker";
const unknownGuest = () =>
  new LocalRefusal(
    "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
    "The guest's termination is unconfirmed; its independent VM owner must settle it.",
  );

/** The only commands accepted here come from the installed release, never from an operation payload. */
export async function attachFixedGuest(
  home: string,
  namespace: string,
  name: string,
  mode: GuestMode,
  input: AsyncIterable<Uint8Array>,
  stdout: Writable,
  stderr: Writable,
  signal?: AbortSignal,
): Promise<number> {
  if (mode !== "installer" && mode !== "worker")
    throw new LocalRefusal("LOCAL_GUEST_COMMAND_INVALID", "Unknown guest entrypoint.");
  const socketPath = await ownedSocket(home, namespace, name);
  const body = JSON.stringify({
    cmd: mode === "installer" ? GUEST_INSTALL_COMMAND : GUEST_WORKER_COMMAND,
    env: {},
    tty: false,
  });
  let peer: Socket | undefined;
  try {
    const attached = await new Promise<{ peer: Socket; head: Buffer; id: string }>(
      (resolve, reject) => {
        const operation = request({
          socketPath,
          path: `/sandbox/${name}/exec/attach`,
          method: "POST",
          agent: false,
          signal,
          maxHeaderSize: 8192,
          headers: {
            connection: "Upgrade",
            upgrade: "tcp",
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          },
        });
        const deadline = setTimeout(() => operation.destroy(unknownGuest()), 15_000);
        operation.once("error", (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        operation.once("response", (response) => {
          clearTimeout(deadline);
          response.destroy();
          reject(unknownGuest());
        });
        operation.once("upgrade", (response, socket, head) => {
          clearTimeout(deadline);
          const id = response.headers["sandboxes-exec-id"];
          if (
            response.statusCode !== 101 ||
            response.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
              "application/vnd.docker.raw-stream" ||
            typeof id !== "string" ||
            !/^[a-f0-9]{64}$/.test(id) ||
            response.headers.upgrade?.toLowerCase() !== "tcp" ||
            !response.headers.connection
              ?.toLowerCase()
              .split(",")
              .map((value) => value.trim())
              .includes("upgrade")
          ) {
            socket.destroy();
            reject(unknownGuest());
            return;
          }
          socket.allowHalfOpen = true;
          socket.setTimeout(0);
          resolve({ peer: socket, head, id });
        });
        operation.end(body);
      },
    );
    peer = attached.peer;
    const outputFailed = (error: Error) => peer?.destroy(error);
    stdout.on("error", outputFailed);
    stderr.on("error", outputFailed);
    const cancel = () => peer?.destroy(unknownGuest());
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const write = (destination: Writable, bytes: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        destination.write(bytes, (error) => (error ? reject(error) : resolve()));
      });
    const send = async () => {
      for await (const bytes of input) await write(attached.peer, bytes);
      attached.peer.end(); // CloseWrite: stdin EOF must not close the peer's readable stream.
    };
    const receive = async () => {
      const header = Buffer.alloc(8);
      let filled = 0,
        remaining = 0;
      let destination: Writable = stdout;
      const chunks = async function* () {
        if (attached.head.length) yield attached.head;
        yield* attached.peer;
      };
      for await (const chunk of chunks()) {
        let offset = 0;
        while (offset < chunk.length) {
          if (!remaining) {
            const length = Math.min(8 - filled, chunk.length - offset);
            chunk.copy(header, filled, offset, offset + length);
            filled += length;
            offset += length;
            if (filled !== 8) continue;
            if (![1, 2].includes(header[0]) || header[1] || header[2] || header[3])
              throw unknownGuest();
            remaining = header.readUInt32BE(4);
            if (remaining > MAX_MESSAGE_BYTES) throw unknownGuest();
            destination = header[0] === 1 ? stdout : stderr;
            filled = 0;
            if (!remaining) continue;
          }
          const length = Math.min(remaining, chunk.length - offset);
          await write(destination, chunk.subarray(offset, offset + length));
          remaining -= length;
          offset += length;
        }
      }
      if (filled || remaining) throw unknownGuest();
    };
    try {
      await Promise.all([send(), receive()]);
    } finally {
      signal?.removeEventListener("abort", cancel);
      stdout.removeListener("error", outputFailed);
      stderr.removeListener("error", outputFailed);
    }
    const result = z
      .object({
        id: z.literal(attached.id),
        running: z.literal(false),
        exit_code: z.number().int().min(0).max(255),
      })
      .passthrough()
      .parse(
        JSON.parse(
          (
            await call(
              socketPath,
              "GET",
              `/sandbox/${name}/exec/${attached.id}`,
              200,
              undefined,
              signal,
            )
          ).toString("utf8"),
        ),
      );
    return result.exit_code;
  } catch {
    throw unknownGuest();
  } finally {
    peer?.destroy();
  }
}

async function createFromInput(): Promise<void> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096)
      throw new LocalRefusal("LOCAL_INPUT_LIMIT", "The local creation profile is too large.");
    chunks.push(bytes);
  }
  const created = await createWithoutGateway(
    process.argv[2],
    process.argv[3],
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  process.stdout.write(JSON.stringify(created));
}

if (
  process.argv[1] &&
  new URL(import.meta.url).pathname.endsWith("/runtime-api.js") &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (
    process.argv.length === 6 &&
    (process.argv[4] === "installer" || process.argv[4] === "worker")
  ) {
    void attachFixedGuest(
      process.argv[2],
      process.argv[3],
      process.argv[5],
      process.argv[4],
      process.stdin,
      process.stdout,
      process.stderr,
    ).then(
      (exitCode) => {
        process.exitCode = exitCode === 0 ? 0 : VERIFIED_GUEST_FAILURE_EXIT;
      },
      () => {
        process.stderr.write("Guest termination is unconfirmed.\n");
        process.exitCode = 201;
      },
    );
  } else if (process.argv.length === 6 && process.argv[4] === "container-identity") {
    void readContainerIdentity(process.argv[2], process.argv[3], process.argv[5]).then(
      (value) => {
        process.stdout.write(JSON.stringify(value));
      },
      () => {
        process.stderr.write("Owned SDK container identity was refused.\n");
        process.exitCode = 1;
      },
    );
  } else if (process.argv.length === 5 && process.argv[4] === "create") {
    void createFromInput().catch(() => {
      process.stderr.write("Safe local SDK creation was refused.\n");
      process.exitCode = 1;
    });
  } else if (process.argv.length !== 6 || !["present", "absent"].includes(process.argv[5]))
    process.exitCode = 1;
  else
    void startWithoutGateway(
      process.argv[2],
      process.argv[3],
      process.argv[4],
      process.argv[5] === "present",
    ).catch(() => {
      process.stderr.write("Safe local SDK startup was refused.\n");
      process.exitCode = 1;
    });
}
