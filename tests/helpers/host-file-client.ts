import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  FileClientAssets,
  FileClientConfiguration,
} from "../../packages/web-backend/src/services/codespace-file-client-assets.js";

/** Only provider Linux life and maintenance are emulated; the installed CLI remains actual bytes. */
export function hostFileClientRequest(source: string, stdin: Uint8Array = new Uint8Array()) {
  return {
    argv: [process.execPath, "-e", source],
    stdin,
    timeoutMs: 10_000,
    maxStdoutBytes: 16_384,
    maxStderrBytes: 4096,
    maxRetainedBytes: 65_536,
  };
}

export function hostFileClientLife(environmentId: string) {
  const life =
    process.platform === "linux"
      ? createHash("sha256")
          .update(
            `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}|${readFileSync("/proc/1/stat", "utf8").split(") ")[1].split(" ")[19]}`,
          )
          .digest("hex")
      : createHash("sha256").update(`override:${environmentId}`).digest("hex");
  return hostFileClientRequest(
    `process.stdout.write(${JSON.stringify(JSON.stringify({ environmentIdentity: life }))})`,
  );
}

export function hostFileClientMaintenance(
  assets: FileClientAssets,
  config: FileClientConfiguration,
  workerPath?: string,
) {
  return hostFileClientRequest(
    "const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');const input=JSON.parse(fs.readFileSync(0,'utf8'));const dir=path.join(os.homedir(),'.local/share/moira-files'),bin=path.join(os.homedir(),'.local/bin'),command=path.join(bin,'moira-files');fs.mkdirSync(dir,{recursive:true,mode:448});fs.mkdirSync(bin,{recursive:true,mode:448});const cli=Buffer.from(input.cli,'base64');fs.writeFileSync(path.join(dir,'client.mjs'),cli,{mode:448});fs.writeFileSync(command,cli,{mode:448});fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(input.config),{mode:384});const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');let workerSha256=null;if(input.worker){fs.mkdirSync(path.dirname(input.workerPath),{recursive:true});fs.writeFileSync(input.workerPath,Buffer.from(input.worker,'base64'),{mode:384});workerSha256=sha(fs.readFileSync(input.workerPath))}process.stdout.write(JSON.stringify({abi:1,environmentIdentity:input.config.environmentIdentity,workerSha256,cliSha256:sha(fs.readFileSync(path.join(dir,'client.mjs'))),command,executableSha256:sha(fs.readFileSync(command))}))",
    Buffer.from(
      JSON.stringify({
        cli: assets.cli.toString("base64"),
        config,
        worker: assets.worker?.toString("base64") ?? null,
        workerPath,
      }),
    ),
  );
}
