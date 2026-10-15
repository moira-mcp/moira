import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { LocalRefusal } from "./policy.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function processGroupHelperAsset(): string {
  return fileURLToPath(
    new URL(
      /\/src\/process-custody\.(?:ts|js)$/.test(new URL(import.meta.url).pathname)
        ? "../dist/process-group-helper"
        : "process-group-helper",
      import.meta.url,
    ),
  );
}

export interface ProcessCustodyWitness {
  version: 1;
  path: string;
  nonce: string;
  device: string;
  inode: string;
}
export const processCustodyWitnessSchema = z
  .object({
    version: z.literal(1),
    path: z.string().startsWith("/"),
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    device: z.string().regex(/^[0-9]+$/),
    inode: z.string().regex(/^[0-9]+$/),
  })
  .strict();
export interface ProcessCustody {
  directory: string;
  prepared(witness: ProcessCustodyWitness): Promise<void>;
}
const unknown = () =>
  new LocalRefusal("LOCAL_CUSTODY_UNCONFIRMED", "Provisioning process settlement is unconfirmed.");

/** The owner journals this identity before spawning; only the held native descriptor can settle it. */
export async function prepareProcessCustody(custody: ProcessCustody) {
  const canonical = await realpath(custody.directory);
  const directory = await lstat(canonical);
  if (
    canonical !== custody.directory ||
    !directory.isDirectory() ||
    directory.mode & 0o077 ||
    directory.uid !== process.getuid?.()
  )
    throw unknown();
  const nonce = randomBytes(32).toString("hex");
  const path = join(canonical, `.custody-${nonce}`);
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let parent: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await handle.writeFile(`pending:${nonce}\n`);
    await handle.sync();
    parent = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    await parent.sync();
    const metadata = await handle.stat({ bigint: true });
    const witness: ProcessCustodyWitness = {
      version: 1,
      path,
      nonce,
      device: String(metadata.dev),
      inode: String(metadata.ino),
    };
    await custody.prepared(witness);
    return { handle, parent, witness };
  } catch (error) {
    await handle.close();
    await parent?.close();
    throw error;
  }
}

/** Pure restart observation: absence, substitution and partial writes never prove quiescence. */
export async function inspectProcessCustody(
  witness: ProcessCustodyWitness,
  helper = processGroupHelperAsset(),
): Promise<"pending" | "settled"> {
  if (!processCustodyWitnessSchema.safeParse(witness).success) throw unknown();
  const handle = await open(witness.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw unknown();
  });
  try {
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1n ||
      metadata.mode & 0o077n ||
      metadata.uid !== BigInt(process.getuid?.() ?? -1) ||
      String(metadata.dev) !== witness.device ||
      String(metadata.ino) !== witness.inode ||
      metadata.size > 80n
    )
      throw unknown();
    const value = await handle.readFile("utf8");
    const current = await lstat(witness.path, { bigint: true });
    if (current.dev !== metadata.dev || current.ino !== metadata.ino) throw unknown();
    if (value === `pending:${witness.nonce}\n`) return "pending";
    if (value === `settled:${witness.nonce}\n`) {
      try {
        await promisify(execFile)(
          helper,
          ["--inspect-custody", witness.path, witness.nonce, witness.device, witness.inode],
          { env: {}, maxBuffer: 1024 },
        );
        return "settled";
      } catch (error) {
        if ((error as { code?: unknown }).code === 1) return "pending";
        throw unknown();
      }
    }
    throw unknown();
  } finally {
    await handle.close();
  }
}
