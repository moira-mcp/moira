import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";
const execute = promisify(execFile);
async function git(root, ...args) {
  return (
    await execute("/usr/bin/git", ["-C", root, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    })
  ).stdout.trim();
}
export async function originalGitOrigin(root) {
  const values = (await git(root, "config", "--get-all", "remote.origin.url")).split("\n");
  if (values.length !== 1 || !values[0]) throw new Error("Repository origin is ambiguous");
  if (
    await git(root, "config", "--get-all", "remote.origin.pushurl").catch((error) => {
      if (error.code === 1) return "";
      throw error;
    })
  )
    throw new Error("Independent push URL is not approved");
  return values[0];
}
async function matchingRewrites(root, canonicalOrigin) {
  const entries = await git(
    root,
    "config",
    "--get-regexp",
    "^url\\..*\\.(insteadof|pushinsteadof)$",
  ).catch((error) => {
    if (error.code === 1) return "";
    throw error;
  });
  return entries
    ? entries
        .split("\n")
        .filter((entry) => canonicalOrigin.startsWith(entry.slice(entry.indexOf(" ") + 1)))
    : [];
}
export async function verifyOwnerGit(root, canonicalOrigin, brokerOrigin) {
  if (
    (await originalGitOrigin(root)) !== canonicalOrigin ||
    (await git(root, "remote", "get-url", "origin")) !== brokerOrigin ||
    (await git(root, "remote", "get-url", "--push", "origin")) !== brokerOrigin
  )
    throw new Error("Repository transport identity changed");
  const matches = await matchingRewrites(root, canonicalOrigin);
  if (matches.length !== 1 || matches[0] !== `url.${brokerOrigin}.insteadof ${canonicalOrigin}`)
    throw new Error("Repository rewrite authority changed");
}
/** Preserve the canonical remote declaration; own only its exact fixed transport rewrite. */
export async function configureOwnerGit(root, canonicalOrigin, brokerOrigin, previous) {
  if ((await originalGitOrigin(root)) !== canonicalOrigin)
    throw new Error("Repository origin changed");
  const effective = await git(root, "remote", "get-url", "origin");
  const push = await git(root, "remote", "get-url", "--push", "origin");
  const allowed =
    previous?.canonicalOrigin === canonicalOrigin ? previous.brokerOrigin : canonicalOrigin;
  if (effective !== allowed || push !== allowed) throw new Error("Repository transport changed");
  if (previous) await verifyOwnerGit(root, canonicalOrigin, previous.brokerOrigin);
  else if ((await matchingRewrites(root, canonicalOrigin)).length)
    throw new Error("Repository transport changed");
  if (previous && previous.brokerOrigin !== brokerOrigin) {
    await git(root, "config", "--local", "--unset-all", `url.${previous.brokerOrigin}.insteadOf`);
  }
  await git(root, "config", "--local", `url.${brokerOrigin}.insteadOf`, canonicalOrigin);
  await verifyOwnerGit(root, canonicalOrigin, brokerOrigin);
}
