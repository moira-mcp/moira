import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CODESPACE_PROVIDER_LOCAL } from "@mcp-moira/shared/local-device-types";

export const FILE_CLIENT_ABI = 1;

export interface FileClientConfiguration {
  version: 1;
  origin: string;
  bootstrapCapability: string;
  environmentIdentity: string;
  resourceId: string;
  repositoryFullName: string;
}

export interface FileClientAssets {
  abi: 1;
  cli: Buffer;
  cliSha256: string;
  worker: Buffer | null;
  workerSha256: string | null;
}

export async function loadFileClientAssets(provider: string): Promise<FileClientAssets> {
  const cli = await readFile(
    new URL("../../dist/guest-assets/guest-files-cli.js", import.meta.url),
  );
  const worker =
    provider === CODESPACE_PROVIDER_LOCAL
      ? await readFile(new URL("../../dist/guest-assets/guest-worker.js", import.meta.url))
      : null;
  return {
    abi: FILE_CLIENT_ABI,
    cli,
    cliSha256: createHash("sha256").update(cli).digest("hex"),
    worker,
    workerSha256: worker ? createHash("sha256").update(worker).digest("hex") : null,
  };
}

const LIFE = String.raw`
const f=require('node:fs'),c=require('node:crypto');
function life(){const boot=f.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();const p=f.readFileSync('/proc/1/stat','utf8');const start=p.slice(p.lastIndexOf(') ')+2).split(' ')[19];if(!boot||!/^[0-9]+$/.test(start))throw Error('life unavailable');return c.createHash('sha256').update(boot+'|'+start).digest('hex')}
`;

const INSTALLER = `${LIFE}${String.raw`
const p=require('node:path'),o=require('node:os'),s=require('node:child_process');
const data=f.readFileSync(0);if(data.length>4*1024*1024)throw Error('maintenance bound');
const input=JSON.parse(data.toString('utf8')),home=o.homedir(),directory=p.join(home,'.local/share/moira-files');
if(!Number.isSafeInteger(input.admissionDeadlineAt)||Date.now()>=input.admissionDeadlineAt)throw Error('maintenance admission closed');
if(input.abi!==1||input.config.version!==1||input.config.environmentIdentity!==life())throw Error('maintenance identity');
function directorySafe(path){f.mkdirSync(path,{recursive:true,mode:448});const v=f.lstatSync(path);if(!v.isDirectory()||v.isSymbolicLink()||v.uid!==process.getuid()||f.realpathSync(path)!==path)throw Error('unsafe install directory')}
directorySafe(p.join(home,'.local'));directorySafe(p.join(home,'.local/share'));directorySafe(directory);directorySafe(p.join(home,'.local/bin'));
const lockPath=p.join(directory,'.install.lock'),lockFd=f.openSync(lockPath,f.constants.O_RDWR|f.constants.O_CREAT|f.constants.O_NOFOLLOW,384),lockIdentity=f.fstatSync(lockFd);
if(!lockIdentity.isFile()||lockIdentity.nlink!==1||lockIdentity.uid!==process.getuid())throw Error('unsafe install lock');
const lock=s.spawn('/bin/sh',['-c','/usr/bin/flock --exclusive 3 || exit 1; printf 1; cat >/dev/null'],{stdio:['pipe','pipe','pipe',lockFd]});
f.closeSync(lockFd);
lock.stderr.resume();lock.stdin.on('error',()=>{});
lock.once('error',()=>process.exit(1));lock.once('close',()=>process.exit(1));
lock.stdout.once('data',()=>{try{
if(Date.now()>=input.admissionDeadlineAt)throw Error('maintenance admission closed');
const observedLock=f.lstatSync(lockPath);if(!observedLock.isFile()||observedLock.nlink!==1||observedLock.dev!==lockIdentity.dev||observedLock.ino!==lockIdentity.ino)throw Error('install lock changed');
function replace(path,bytes,mode){const parent=p.dirname(path),before=f.lstatSync(parent);if(!before.isDirectory()||before.isSymbolicLink()||before.uid!==process.getuid()||f.realpathSync(parent)!==parent)throw Error('unsafe install path');try{const existing=f.lstatSync(path);if(!existing.isFile()||existing.nlink!==1||existing.uid!==process.getuid())throw Error('unsafe install asset')}catch(e){if(e.code!=='ENOENT')throw e}const tmp=p.join(parent,'.moira-install-'+c.randomBytes(16).toString('hex'));let fd;try{fd=f.openSync(tmp,f.constants.O_WRONLY|f.constants.O_CREAT|f.constants.O_EXCL|f.constants.O_NOFOLLOW,mode);f.writeFileSync(fd,bytes);f.fsyncSync(fd);f.closeSync(fd);fd=undefined;const after=f.lstatSync(parent);if(after.dev!==before.dev||after.ino!==before.ino)throw Error('install parent changed');f.renameSync(tmp,path);const d=f.openSync(parent,f.constants.O_RDONLY|f.constants.O_DIRECTORY|f.constants.O_NOFOLLOW);try{f.fsyncSync(d)}finally{f.closeSync(d)}}finally{if(fd!==undefined)f.closeSync(fd);try{f.unlinkSync(tmp)}catch(e){if(e.code!=='ENOENT')throw e}}}
function asset(value,digest){const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value||bytes.length>1024*1024||c.createHash('sha256').update(bytes).digest('hex')!==digest)throw Error('asset digest');return bytes}
const cli=asset(input.cli,input.cliSha256),worker=input.worker===null?null:asset(input.worker,input.workerSha256);
if(worker){directorySafe('/tmp/moira-local-runtime');replace('/tmp/moira-local-runtime/worker.mjs',worker,384)}
replace(p.join(directory,'client.mjs'),cli,448);replace(p.join(home,'.local/bin/moira-files'),cli,448);replace(p.join(directory,'config.json'),Buffer.from(JSON.stringify(input.config)),384);
const observed=life();if(observed!==input.config.environmentIdentity)throw Error('maintenance life changed');
function sha(path,executable=false){if(executable)f.accessSync(path,f.constants.X_OK);const fd=f.openSync(path,f.constants.O_RDONLY|f.constants.O_NOFOLLOW);try{const before=f.fstatSync(fd,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size>1048576n)throw Error('unsafe measured asset');const digest=c.createHash('sha256').update(f.readFileSync(fd)).digest('hex'),after=f.fstatSync(fd,{bigint:true}),named=f.lstatSync(path,{bigint:true});for(const key of ['dev','ino','size','nlink','mtimeNs','ctimeNs'])if(before[key]!==after[key]||before[key]!==named[key])throw Error('measured asset changed');return digest}finally{f.closeSync(fd)}}
const command=p.join(home,'.local/bin/moira-files'),cliSha256=sha(p.join(directory,'client.mjs')),executableSha256=sha(command,true);if(executableSha256!==cliSha256||cliSha256!==input.cliSha256)throw Error('measured executable mismatch');
process.stdout.write(JSON.stringify({abi:1,environmentIdentity:observed,workerSha256:worker?sha('/tmp/moira-local-runtime/worker.mjs'):null,cliSha256,command,executableSha256})+String.fromCharCode(10));
lock.removeAllListeners('close');lock.stdin.end();lock.once('close',code=>process.exit(code===0?0:1));
}catch{lock.kill();process.exit(1)}});
`}`;

function fixedRequest(source: string, stdin: Uint8Array = new Uint8Array()) {
  return {
    argv: ["node", "-e", source],
    stdin,
    timeoutMs: 60_000,
    maxStdoutBytes: 16_384,
    maxStderrBytes: 4096,
    maxRetainedBytes: 65_536,
  };
}

export function buildFileClientLifeProbe() {
  return fixedRequest(
    `${LIFE}process.stdout.write(JSON.stringify({environmentIdentity:life()})+String.fromCharCode(10));`,
  );
}

export function buildFileClientMaintenance(
  assets: FileClientAssets,
  config: FileClientConfiguration,
  admissionDeadlineAt: number,
) {
  const value = {
    abi: assets.abi,
    cli: assets.cli.toString("base64"),
    cliSha256: assets.cliSha256,
    worker: assets.worker?.toString("base64") ?? null,
    workerSha256: assets.workerSha256,
    config,
    admissionDeadlineAt,
  };
  return fixedRequest(INSTALLER, Buffer.from(JSON.stringify(value)));
}
