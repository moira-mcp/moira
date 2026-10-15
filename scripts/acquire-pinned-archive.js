import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { get } from "node:https";
import { pipeline } from "node:stream/promises";

async function digest(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest(encoding);
}

async function openArchive(url, redirects = 0) {
  const address = new URL(url);
  if (address.protocol !== "https:" || address.username || address.password)
    throw new Error("Pinned archives require HTTPS without URL credentials");
  const response = await new Promise((resolve, reject) => {
    get(address, resolve).once("error", reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy();
    if (!response.headers.location || redirects === 20)
      throw new Error("Pinned archive redirect refused");
    return openArchive(new URL(response.headers.location, address), redirects + 1);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.destroy();
    throw new Error(`Pinned archive download failed (${response.statusCode})`);
  }
  return response;
}

/** Download build inputs through native Node streams; publish only a complete pinned archive. */
export async function acquirePinnedArchive({ url, target, algorithm, expected, encoding }) {
  try {
    if ((await digest(target, algorithm, encoding)) === expected) return target;
    throw new Error("Cached archive failed its pinned integrity");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${target}.next-${randomUUID()}`;
  try {
    const response = await openArchive(url);
    await pipeline(response, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    if ((await digest(temporary, algorithm, encoding)) !== expected)
      throw new Error("Downloaded archive failed its pinned integrity");
    await rename(temporary, target);
    return target;
  } finally {
    await rm(temporary, { force: true });
  }
}
