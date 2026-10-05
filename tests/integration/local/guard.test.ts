import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { createHash, randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { localFixture } from "./fixtures.js";

const execute = promisify(execFile);
let root: string;
let daemons: ChildProcess[];
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "mg-")),
  );
  daemons = [];
});
afterEach(async () => {
  for (const daemon of daemons)
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const closed = once(daemon, "close");
      daemon.kill("SIGTERM");
      await closed;
    }
  await rm(root, { recursive: true, force: true });
});

async function fixture(pendingCreation = false, stoppedInventory = false) {
  const state = await PrivateState.open(join(root, "state"));
  const local = await localFixture(state);
  const sdkId = randomUUID();
  if (!pendingCreation) local.space.runtimeId = sdkId;
  const binary = join(root, "Sbx.app", "Contents", "MacOS", "sbx");
  await mkdir(join(root, "Sbx.app", "Contents", "MacOS"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "Sbx.app", "Contents", "Helpers"), { recursive: true, mode: 0o700 });
  const observation = join(root, "native.json");
  const pending = join(root, "pending.json");
  const release = join(root, "release");
  const sentinel = join(root, "executed");
  await writeFile(
    observation,
    JSON.stringify({
      status: pendingCreation ? "absent" : stoppedInventory ? "stopped" : "running",
    }),
  );
  // A separate real executable models SDK effects; this is not a microVM proof.
  const dispatch = join(root, "dispatch.cjs");
  await writeFile(
    dispatch,
    `
const f=require('node:fs');const path=${JSON.stringify(observation)};
const args=process.argv.slice(2);const current=()=>JSON.parse(f.readFileSync(path));
const peersPath=path+'.peers';const peers=()=>f.existsSync(peersPath)?JSON.parse(f.readFileSync(peersPath)):[];
const sdkRows=()=>[...(current().status==='absent'?[]:[{id:${JSON.stringify(sdkId)},name:${JSON.stringify(local.space.name)},agent:'shell',status:current().status}]),...peers()];
const cid=name=>require('node:crypto').createHash('sha256').update(name).digest('hex');
process.on('exit',()=>f.writeFileSync(path+'.running-cids',sdkRows().filter(row=>row.status==='running').map(row=>cid(row.name)).join('')));
const pending=${JSON.stringify(pending)};const release=${JSON.stringify(release)};const sentinel=${JSON.stringify(sentinel)};
const settings={'env.rememberHostCommands':false,'ssh.autoCreate':false,'ssh.workspaceRoot':'','clipboard.imagePaste':false,'ssh.agentForwardingEnabled':false,'ssh.agentSocketPath':'','skills.defaultMode':'off','diagnostics.autoUpload':'no','proxy.integratedAuth':false,'proxy.sandbox':'direct','no_proxy.sandbox':''};
if(args[0]==='version')process.stdout.write('sbx version: v0.46.0 verified ');
else if(args[0]==='settings'&&args[1]==='get'&&args[2]==='feature.network-user-prompts')process.stdout.write(JSON.stringify({key:'feature.network-user-prompts',value:{enabled:false,variant:'',variantPayload:''},source:'override'}));
else if(args[0]==='settings')process.stdout.write(JSON.stringify(Object.entries(settings).map(([key,value])=>({key,value}))));
else if(args[0]==='inspect')process.stdout.write(JSON.stringify({name:args.at(-1),agent:'shell',image:${JSON.stringify(local.policy.runtime.template)},image_digest:${JSON.stringify(local.policy.runtime.template.split("@")[1])},cpus:1,memory:'1024m',network:args.at(-1),runtime_mounts:[],daemon_version:'v0.46.0',kits:[],secrets:[],ports:[],mcp_gateway:false,auth_mode:'',network_policy:{}}));
else if(args[0]==='policy'){
  if(args[1]==='check'){const protocol=args[args.indexOf('--protocol')+1];const name=args[args.indexOf('--sandbox')+1];const target=args.at(-1);const allowed=protocol==='tcp'&&target==='localhost:42500';process.stdout.write(JSON.stringify({type:'network',action:'net:connect:'+protocol,target,context:'sandbox:'+name,allowed,governance:{active:false}}));process.exit(allowed?0:1);}
  process.stdout.write(args[2]==='--json'?JSON.stringify({rules:[{resource_type:'network',scope:'global',applies_to:'all',decision:'deny',status:'active',resources:['**'],actions:['net:connect:udp']}]}):'[]');
}
else if(args[0]==='run')f.writeFileSync(path,JSON.stringify({status:'running'}));
else if(args[0]==='ls') {
  const emit=()=>process.stdout.write(f.existsSync(path+'.inventory')?f.readFileSync(path+'.inventory'):JSON.stringify({sandboxes:sdkRows()}));
  if(f.existsSync(path+'.inventory-wait')){f.writeFileSync(path+'.inventory-entered',JSON.stringify({pid:process.pid}));const t=setInterval(()=>{if(f.existsSync(path+'.inventory-release')){clearInterval(t);emit();}},10);}else emit();
}
else if(args[0]==='docker-identity'){
  const filter=JSON.parse(decodeURIComponent(args[1].split('filters=')[1]));const name=filter.label[0].split('=')[1];
  const row=sdkRows().find(row=>row.name===name);const data=row?[{Id:cid(name),Names:['/'+name],State:row.status==='running'?'running':'exited',Labels:{'com.docker.sandbox.name':name,'com.docker.sdk':'true','docker/sandbox':'true'}}]:[];
  f.writeFileSync(path+'.container-response',JSON.stringify(data));
}
else if(args[0]==='worker-id')f.writeFileSync(path+'.worker-id',cid(args[1]));
else if(args[0]==='initial-worker')process.exit(current().status==='running'?0:1);
else if(args[0]==='api-guest'){
  const bytes=f.readFileSync(0);const name=args[1];
  const finish=result=>{f.writeFileSync(path+'.guest-exit.'+name,'0');if(result!==undefined)process.stdout.write(JSON.stringify({ok:true,result}));};
  if(args[2]==='installer')finish();
  else {
    const body=JSON.parse(bytes.toString());
    if(body.kind==='bootstrap')finish({});
    else {
      f.writeFileSync(pending,JSON.stringify({pid:process.pid}));f.writeFileSync(pending+'.'+name,JSON.stringify({pid:process.pid}));
      if(f.existsSync(path+'.guest-unknown'))process.exit(1);
      const timer=setInterval(()=>{if(f.existsSync(release)){clearInterval(timer);f.writeFileSync(sentinel,'late side effect');finish({state:'complete',exitCode:0});}},10);
    }
  }
}
else if(args[0]==='api-start'){
  if(args[1]===${JSON.stringify(local.space.name)})f.writeFileSync(path,JSON.stringify({status:'running'}));
  f.writeFileSync(peersPath,JSON.stringify(peers().map(row=>row.name===args[1]?{...row,status:'running'}:row)));
}
else if(args[0]==='api-create'){
  const body=JSON.parse(args[1]);if(body.name!==${JSON.stringify(local.space.name)}||body.agent!=='shell'||body.workspace!==''||body.cpus!==${local.policy.runtime.cpuCores}||body.template!==${JSON.stringify(local.policy.runtime.template)}||Object.keys(body.environment).length||body.kits.length||body.credential_values.length)process.exit(2);
  const complete=()=>{f.writeFileSync(path,JSON.stringify({status:'running'}));f.writeFileSync(path+'.create-response',JSON.stringify({name:body.name,agent:'shell',workspace:'',status:'created'}));};
  ${pendingCreation ? `f.writeFileSync(path,JSON.stringify({status:'starting'}));f.writeFileSync(pending,JSON.stringify({pid:process.pid}));f.writeFileSync(pending+'.'+body.name,JSON.stringify({pid:process.pid}));const timer=setInterval(()=>{if(f.existsSync(release)){clearInterval(timer);complete();f.writeFileSync(sentinel,'late side effect');}},10);` : `complete();`}
}
else if(args[0]==='stop'){if(args[1]===${JSON.stringify(local.space.name)})f.writeFileSync(path,JSON.stringify({status:'stopped'}));f.writeFileSync(peersPath,JSON.stringify(peers().map(peer=>peer.name===args[1]?{...peer,status:'stopped'}:peer)));}
else if(args[0]==='daemon'&&args[1]==='status')process.stdout.write(JSON.stringify({status:f.existsSync(path+'.daemon-stopped')?'stopped':'running',socket:process.env.HOME+'/.sbx/run_'+process.env.DOCKER_SANDBOXES_APP_NAME+'/d/sandboxd.sock'}));
else if(args[0]==='daemon'&&args[1]==='stop'){if(current().status!=='absent')f.writeFileSync(path,JSON.stringify({status:'stopped'}));f.writeFileSync(path+'.daemon-stopped','stopped');f.writeFileSync(peersPath,JSON.stringify(peers().map(peer=>({...peer,status:'stopped'}))));}
else if(args[0]==='exec'||args[0]==='create'){
  if(args[0]==='exec'){
    if(args[4]==='-e'){process.exit(0);}
    const input=JSON.parse(f.readFileSync(0,'utf8'));
    if(input.kind==='bootstrap'){process.stdout.write(JSON.stringify({ok:true,result:{}}));process.exit(0);}
  }
  if(args[0]==='create')f.writeFileSync(path,JSON.stringify({status:'starting'}));
  f.writeFileSync(pending,JSON.stringify({pid:process.pid}));
  const name=args[0]==='create'?args[args.indexOf('--name')+1]:args[2];f.writeFileSync(pending+'.'+name,JSON.stringify({pid:process.pid}));
  const timer=setInterval(()=>{if(f.existsSync(release)){clearInterval(timer);f.writeFileSync(path,JSON.stringify({status:'running'}));f.writeFileSync(sentinel,'late side effect');process.stdout.write('{}');}},10);
}
else process.exit(1);
`,
    { mode: 0o700 },
  );
  const nativeSource = join(root, "sdk.c");
  await writeFile(
    nativeSource,
    `
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
static volatile sig_atomic_t stopped=0;
static void stop(int sig){(void)sig;stopped=1;}
static int command(int argc,char **argv){
  pid_t p=fork();if(p<0)return 1;
  if(!p){char **a=calloc((size_t)argc+3,sizeof(char*));a[0]=${JSON.stringify(process.execPath)};a[1]=${JSON.stringify(dispatch)};
    for(int i=1;i<argc;i++)a[i+1]=argv[i];execv(a[0],a);_exit(1);}
  int status;for(;;){if(waitpid(p,&status,WNOHANG)==p)break;if(stopped){kill(p,SIGKILL);while(waitpid(p,&status,0)<0){}break;}usleep(1000);}return WIFEXITED(status)?WEXITSTATUS(status):1;
}
static pid_t workers[128];static char worker_ids[128][65];static int worker_count=0;
static pid_t guests[128];static char guest_ids[128][65];static int guest_count=0;
static void settle_guests(const char *id){for(int i=0;i<guest_count;i++)if(guests[i]>0&&(!id||!strcmp(guest_ids[i],id))){if(waitpid(guests[i],0,WNOHANG)==0){kill(guests[i],SIGTERM);while(waitpid(guests[i],0,0)<0){}}guests[i]=0;}}
static void reconcile_workers(void){char running[8193]={0};FILE *data=fopen(${JSON.stringify(observation + ".running-cids")},"r");if(data){fread(running,1,sizeof(running)-1,data);fclose(data);}for(int i=0;i<worker_count;i++)if(workers[i]>0){int exited=waitpid(workers[i],0,WNOHANG)==workers[i];if(exited||!strstr(running,worker_ids[i])){if(!exited){kill(workers[i],SIGTERM);while(waitpid(workers[i],0,0)<0){}}workers[i]=0;settle_guests(worker_ids[i]);}}}
static void ensure_worker(char *binary,const char *control,const char *name){
  char *args[]={binary,"worker-id",(char*)name,0};if(command(3,args))return;
  char id[65]={0};FILE *record=fopen(${JSON.stringify(observation + ".worker-id")},"r");if(!record)return;fread(id,1,64,record);fclose(record);
  for(int i=0;i<worker_count;i++)if(!strcmp(worker_ids[i],id)&&workers[i]>0){if(waitpid(workers[i],0,WNOHANG)==0)return;workers[i]=0;}
  char socket[1024],image[1024];snprintf(socket,sizeof(socket),"%s",control);char *separator=strrchr(socket,'/');*separator=0;separator=strrchr(socket,'/');*separator=0;size_t length=strlen(socket);snprintf(socket+length,sizeof(socket)-length,"/%.12s-vm.sock",id);
  snprintf(image,sizeof(image),"%s",binary);separator=strrchr(image,'/');*separator=0;separator=strrchr(image,'/');*separator=0;strcat(image,"/Helpers/containerd-shim-nerdbox-v1");
  int ready[2];if(pipe(ready))return;pid_t child=fork();if(child<0)return;
  if(!child){close(ready[0]);dup2(ready[1],1);close(ready[1]);int empty=open("/dev/null",O_RDWR);if(empty>=0){dup2(empty,0);dup2(empty,2);if(empty>2)close(empty);}int maximum=getdtablesize();for(int descriptor=3;descriptor<maximum;descriptor++)close(descriptor);execl(image,image,"--fixture-vm",socket,"-namespace","docker","-id",id,(char*)0);_exit(2);}
  close(ready[1]);char response[6];read(ready[0],response,sizeof(response));close(ready[0]);workers[worker_count]=child;strcpy(worker_ids[worker_count++],id);
}
static void attach_guest(int fd,char *binary,const char *name,const char *mode){
  char prior[1024];snprintf(prior,sizeof(prior),"%s.guest-exit.%s",${JSON.stringify(observation)},name);unlink(prior);
  const char *upgrade="HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: tcp\\r\\nContent-Type: application/vnd.docker.raw-stream\\r\\nSandboxes-Exec-Id: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\r\\n\\r\\n";write(fd,upgrade,strlen(upgrade));
  int output[2];if(pipe(output))return;pid_t child=fork();if(child<0)return;
  if(!child){dup2(fd,0);dup2(output[1],1);close(output[0]);close(output[1]);execl(${JSON.stringify(process.execPath)},${JSON.stringify(process.execPath)},${JSON.stringify(dispatch)},"api-guest",name,mode,(char*)0);_exit(2);}
  close(output[1]);char bytes[4096];while(!stopped){struct pollfd p={.fd=output[0],.events=POLLIN};if(poll(&p,1,100)>0){ssize_t n=read(output[0],bytes,sizeof(bytes));if(n<=0)break;unsigned char frame[8]={1,0,0,0,0,0,0,0};frame[4]=(n>>24)&255;frame[5]=(n>>16)&255;frame[6]=(n>>8)&255;frame[7]=n&255;write(fd,frame,8);write(fd,bytes,(size_t)n);}}
  if(stopped)kill(child,SIGKILL);while(waitpid(child,0,0)<0){}close(output[0]);(void)binary;
}
static void reply(int fd,int status,const char *body){char header[256];int n=snprintf(header,sizeof(header),"HTTP/1.1 %d OK\\r\\nContent-Length: %zu\\r\\nConnection: close\\r\\n\\r\\n",status,strlen(body));write(fd,header,n);write(fd,body,strlen(body));}
static void body_reply(int fd,int status,const char *file){char body[8192]={0};FILE *data=fopen(file,"r");if(!data){reply(fd,500,"");return;}fread(body,1,sizeof(body)-1,data);fclose(data);reply(fd,status,body);}
static ssize_t read_request(int fd,char *bytes,size_t limit){size_t used=0;for(;;){ssize_t n=read(fd,bytes+used,limit-used-1);if(n<=0)return n;used+=(size_t)n;bytes[used]=0;char *body=strstr(bytes,"\\r\\n\\r\\n");if(body){char *length=strstr(bytes,"content-length: ");size_t content=length?(size_t)strtoul(length+16,0,10):0;if(content>limit-1-(size_t)(body+4-bytes))return -1;if(used>=(size_t)(body+4-bytes)+content)return (ssize_t)used;}if(used==limit-1)return -1;}}
int main(int argc,char **argv){
  signal(SIGPIPE,SIG_IGN);
  char path[1024];int vm=argc==7&&!strcmp(argv[1],"--fixture-vm");
  if(vm)snprintf(path,sizeof(path),"%s",argv[2]);
  else if(argc==3&&!strcmp(argv[1],"--fixture-daemon"))snprintf(path,sizeof(path),"%s",argv[2]);
  else if(argc>=3&&!strcmp(argv[1],"daemon")&&!strcmp(argv[2],"start")){
    FILE *receipt=fopen(${JSON.stringify(observation + ".launches")},"a");if(receipt){fputs("launched\\n",receipt);fclose(receipt);}
    snprintf(path,sizeof(path),"%s/.sbx/run_%s/d/sandboxd.sock",getenv("HOME"),getenv("DOCKER_SANDBOXES_APP_NAME"));
    unlink(${JSON.stringify(observation + ".daemon-stopped")});
  } else return command(argc,argv);
  struct sockaddr_un a={.sun_family=AF_UNIX};if(strlen(path)>=sizeof(a.sun_path))return 2;strcpy(a.sun_path,path);
  if(vm)unlink(path);
  int fd=socket(AF_UNIX,vm?SOCK_DGRAM:SOCK_STREAM,0);if(bind(fd,(struct sockaddr*)&a,sizeof(a))||(!vm&&listen(fd,8)))return 2;
  int docker=-1;char engine[1024];if(!vm){snprintf(engine,sizeof(engine),"%s",path);char *s=strrchr(engine,'/');strcpy(s+1,"docker.sock");struct sockaddr_un d={.sun_family=AF_UNIX};strcpy(d.sun_path,engine);docker=socket(AF_UNIX,SOCK_STREAM,0);if(bind(docker,(struct sockaddr*)&d,sizeof(d))||listen(docker,8))return 2;}
  signal(SIGTERM,stop);puts("ready");fflush(stdout);
  if(!vm){char *initial[]={argv[0],"initial-worker",0};if(!command(2,initial))ensure_worker(argv[0],path,${JSON.stringify(local.space.name)});}
  while(!stopped){if(!vm)reconcile_workers();struct pollfd p[2]={{.fd=fd,.events=POLLIN},{.fd=docker,.events=POLLIN}};if(poll(p,vm?1:2,100)>0&&!vm){int c=accept((p[0].revents&POLLIN)?fd:docker,0,0);if(c>=0){
    struct pollfd client={.fd=c,.events=POLLIN};if(poll(&client,1,1000)>0){char request[4096];ssize_t n=read_request(c,request,sizeof(request));if(n>0){request[n]=0;
      if(!strncmp(request,"POST /sandbox/",14)&&strstr(request,"/exec/attach ")){char name[39]={0};memcpy(name,request+14,38);char *args[]={argv[0],"worker-id",name,0};if(!command(3,args)){char id[65]={0};FILE *record=fopen(${JSON.stringify(observation + ".worker-id")},"r");if(record){fread(id,1,64,record);fclose(record);}pid_t child=fork();if(!child){close(fd);close(docker);attach_guest(c,argv[0],name,strstr(request,"/tmp/moira-local-runtime/worker.mjs")?"worker":"installer");close(c);_exit(0);}if(child>0){guests[guest_count]=child;strcpy(guest_ids[guest_count++],id);}}}
      else if(!strncmp(request,"GET /sandbox/",13)&&strstr(request,"/exec/")){char name[39]={0},file[1024];memcpy(name,request+13,38);snprintf(file,sizeof(file),"%s.guest-exit.%s",${JSON.stringify(observation)},name);FILE *exit=fopen(file,"r");if(exit){fclose(exit);reply(c,200,"{\\"id\\":\\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\",\\"running\\":false,\\"exit_code\\":0}");}else reply(c,500,"");}
      else if(!strncmp(request,"POST /sandbox/",14)&&strstr(request,"/start ")){char name[39]={0};memcpy(name,request+14,38);char *args[]={argv[0],"api-start",name,0};int status=command(3,args);if(!status)ensure_worker(argv[0],path,name);reply(c,status?500:200,"");}
      else if(!strncmp(request,"POST /sandbox ",14)){char *body=strstr(request,"\\r\\n\\r\\n");char *args[]={argv[0],"api-create",body?body+4:"",0};int status=command(3,args);if(!status){ensure_worker(argv[0],path,${JSON.stringify(local.space.name)});body_reply(c,201,${JSON.stringify(observation + ".create-response")});}else reply(c,500,"");}
      else if(!strncmp(request,"GET /containers/json?",21)){char *end=strchr(request+4,' ');if(end)*end=0;char *args[]={argv[0],"docker-identity",request+4,0};int status=command(3,args);if(!status)body_reply(c,200,${JSON.stringify(observation + ".container-response")});else reply(c,500,"");}
      else if(!strncmp(request,"DELETE /sandbox/",16)&&strstr(request,"/mcp/gateway ")){const char *response="HTTP/1.1 204 No Content\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n";write(c,response,strlen(response));}
    }}close(c);
  }}}
  close(fd);unlink(path);if(vm)return 0;close(docker);unlink(engine);settle_guests(0);for(int i=0;i<worker_count;i++)if(workers[i]>0&&waitpid(workers[i],0,WNOHANG)==0){kill(workers[i],SIGTERM);while(waitpid(workers[i],0,0)<0){}}
  char *args[]={argv[0],"daemon","stop",0};stopped=0;return command(3,args);
}
`,
  );
  await execute(process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc", [
    nativeSource,
    "-o",
    binary,
  ]);
  await copyFile(
    binary,
    join(root, "Sbx.app", "Contents", "Helpers", "containerd-shim-nerdbox-v1"),
  );
  local.policy.runtime.binary = binary;
  local.space.networkPolicy = createHash("sha256").update("[]").digest("hex");
  if (pendingCreation) {
    local.space.runtimeId = null;
    local.space.phase = "creating";
    local.space.desiredState = "stopped";
  }
  await local.records.put(local.space);
  await state.write("policy.json", local.policy);
  await mkdir(join(local.policy.runtime.storageRoot, "runtime"), { recursive: true, mode: 0o700 });
  const namespace = `moira-${local.policy.deviceId.replaceAll("-", "").slice(0, 14)}`;
  await mkdir(join(local.policy.runtime.storageRoot, "runtime", ".sbx", `run_${namespace}`, "d"), {
    recursive: true,
    mode: 0o700,
  });
  const home = join(local.policy.runtime.storageRoot, "runtime");
  const socket = join(home, ".sbx", `run_${namespace}`, "d", "sandboxd.sock");
  const daemon = spawn(binary, ["--fixture-daemon", socket], {
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemons.push(daemon);
  expect((await once(daemon.stdout!, "data"))[0].toString()).toBe("ready\n");
  await build({
    entryPoints: [
      "packages/local/src/guard.ts",
      "packages/local/src/private-state.ts",
      "packages/local/src/space-record.ts",
      "packages/local/src/sbx-runtime.ts",
      "packages/local/src/cli.ts",
    ],
    outdir: root,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
  });
  if (process.platform === "darwin")
    await copyFile("packages/local/dist/keychain-helper", join(root, "keychain-helper"));
  await copyFile(
    "packages/local/dist/runtime-control-helper",
    join(root, "runtime-control-helper"),
  );
  await copyFile("packages/local/dist/guest-worker.js", join(root, "guest-worker.js"));
  await copyFile("packages/local/dist/guest-proxy.js", join(root, "guest-proxy.js"));
  await copyFile("packages/local/dist/runtime-api.js", join(root, "runtime-api.js"));
  await state.write("broker.json", { port: 42500 });
  return { ...local, state, observation, pending, release, sentinel };
}

const waitFor = async (read: () => Promise<boolean>) => {
  const deadline = Date.now() + 2500;
  while (!(await read())) {
    if (Date.now() >= deadline) throw new Error("The real subprocess condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// Install before spawning: a fast write cannot be missed, and an early refusal cannot be
// mistaken for slow SDK startup. The existing child startup/test deadlines own lifetime bounds.
function observeInventoryRead(marker: string) {
  let child: ChildProcess | undefined;
  let stderr = () => "";
  let settled = false;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const ready = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const cleanup = () => {
    observer.close();
    child?.off("close", closed);
    child?.off("error", failed);
  };
  const failed = (error: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const closed = (exitCode: number | null, signalCode: string | null) =>
    failed(
      Object.assign(
        new Error(
          `Inventory driver exited before its read barrier: exit=${exitCode}, signal=${signalCode}; ${stderr()}`,
        ),
        { exitCode, signalCode, stderr: stderr() },
      ),
    );
  const inspect = async () => {
    if (!child || settled) return;
    try {
      await readFile(marker);
      if (settled) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        closed(child.exitCode, child.signalCode);
        return;
      }
      settled = true;
      cleanup();
      resolve();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed(error);
    }
  };
  const observer = watch(dirname(marker), () => {
    void inspect();
  });
  observer.unref();
  observer.on("error", failed);
  return {
    wait(driver: ChildProcess, readStderr: () => string) {
      child = driver;
      stderr = readStderr;
      child.once("error", failed);
      child.once("close", closed);
      if (child.exitCode !== null || child.signalCode !== null)
        closed(child.exitCode, child.signalCode);
      else void inspect();
      return ready;
    },
  };
}

function driver(local: Awaited<ReturnType<typeof fixture>>) {
  return `
    import {startGuard} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
    import f from 'node:fs/promises';
    import {watch} from 'node:fs';
    const device=await startGuard(${JSON.stringify(local.state.root)});
    const spacePath=${JSON.stringify(join(local.state.root, `space-${local.space.id}.json`))};
    const space=JSON.parse(await f.readFile(spacePath,'utf8'));space.desiredState='running';await f.writeFile(spacePath,JSON.stringify(space));
    const guard=await device.space(${JSON.stringify(local.space.id)});
    const wait=()=>new Promise((resolve,reject)=>{
      const changed=()=>{void f.readFile(${JSON.stringify(local.pending)}).then(()=>{observer.close();resolve();},error=>{if(error.code!=='ENOENT'){observer.close();reject(error);}});};
      const observer=watch(${JSON.stringify(root)},changed);observer.unref();observer.on('error',reject);changed();
    });
  `;
}
const job = () => ({
  action: "execute",
  repositoryFullName: "owner/project",
  remoteMarker: `moira-op-${"a".repeat(32)}`,
  argv: ["true"],
  stdin: "",
  timeoutMs: 1000,
  maxStdoutBytes: 1024,
  maxStderrBytes: 1024,
  maxRetainedBytes: 1024,
});

async function addPeer(local: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID();
  const peer = {
    ...local.space,
    id,
    name: `moira-${id.replaceAll("-", "")}`,
    runtimeId: randomUUID(),
    phase: "usable" as const,
    desiredState: "running" as const,
  };
  await local.records.put(peer);
  await writeFile(
    local.observation + ".peers",
    JSON.stringify([
      {
        id: peer.runtimeId,
        name: peer.name,
        agent: "shell",
        status: "running",
        workspaces: [],
        ports: [],
      },
    ]),
  );
  await execute(process.execPath, [
    join(root, "runtime-api.js"),
    join(local.policy.runtime.storageRoot, "runtime"),
    `moira-${local.policy.deviceId.replaceAll("-", "").slice(0, 14)}`,
    peer.name,
    "absent",
  ]);
  return peer;
}

async function addStaleVmSocket(local: Awaited<ReturnType<typeof fixture>>) {
  const namespace = `moira-${local.policy.deviceId.replaceAll("-", "").slice(0, 14)}`;
  const socket = join(
    local.policy.runtime.storageRoot,
    "runtime",
    ".sbx",
    `run_${namespace}`,
    "aaaaaaaaaaaa-vm.sock",
  );
  const stale = spawn(
    join(root, "Sbx.app", "Contents", "Helpers", "containerd-shim-nerdbox-v1"),
    ["--fixture-vm", socket, "-namespace", "docker", "-id", "a".repeat(64)],
    {
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  daemons.push(stale);
  expect((await once(stale.stdout!, "data"))[0].toString()).toBe("ready\n");
  const closed = once(stale, "close");
  stale.kill("SIGKILL");
  await closed;
}

const vmTest = process.platform === "darwin" ? test : test.skip;
const supportedGuard = process.platform === "darwin" ? describe : describe.skip;

supportedGuard("independent guard with a real subprocess SDK substitute", () => {
  test.each([0, 7])(
    "inventory readiness refuses an early driver exit %s without a marker",
    async (exitCode) => {
      const marker = join(root, "inventory-entered");
      const readiness = observeInventoryRead(marker);
      const child = spawn(
        process.execPath,
        ["-e", `process.stderr.write('fixture-refusal');process.exit(${exitCode})`],
        { env: {}, stdio: ["ignore", "pipe", "pipe"] },
      );
      daemons.push(child);
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      await expect(readiness.wait(child, () => stderr)).rejects.toMatchObject({
        exitCode,
        signalCode: null,
        stderr: "fixture-refusal",
      });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  vmTest(
    "explicit device recovery after SIGKILL lock owner stops an orphaned live SDK and worker while retaining unknown jobs and disabled work",
    async () => {
      const local = await fixture();
      local.policy.enabled = false;
      await local.state.write("policy.json", local.policy);
      const receipt = {
        owner: randomUUID(),
        profile: createHash("sha256")
          .update(
            JSON.stringify({ deviceId: local.policy.deviceId, runtime: local.policy.runtime }),
          )
          .digest("hex"),
        settled: false,
      };
      await local.state.write("runtime-owner.json", receipt);
      const jobKey = `job-${"c".repeat(64)}.json`;
      const unknownJob = { unknown: true, terminal: false, marker: `moira-op-${"c".repeat(32)}` };
      await local.state.write(jobKey, unknownJob);
      const spaceBytes = await readFile(join(local.state.root, `space-${local.space.id}.json`));
      const prior = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import {PrivateState} from ${JSON.stringify(`file://${join(root, "private-state.js")}`)};
        const state=await PrivateState.open(${JSON.stringify(local.state.root)});
        await state.lock();process.stdout.write('ready');process.stdin.resume();
      `,
        ],
        { env: {}, stdio: ["pipe", "pipe", "pipe"] },
      );
      daemons.push(prior);
      await Promise.race([
        once(prior.stdout!, "data"),
        once(prior, "close").then(() => {
          throw Error("Lock owner refused before ready");
        }),
      ]);
      const exited = once(prior, "close");
      prior.kill("SIGKILL");
      await exited;
      await expect(local.state.lock()).rejects.toThrow("Another companion owns");
      await execute(process.execPath, [
        join(root, "cli.js"),
        "recover",
        "--confirm",
        "--state",
        local.state.root,
      ]);
      expect(JSON.parse(await readFile(local.observation, "utf8"))).toEqual({ status: "stopped" });
      expect(await local.state.read("runtime-owner.json", (value) => value)).toMatchObject({
        profile: receipt.profile,
        settled: true,
      });
      expect((await local.records.policy()).enabled).toBe(false);
      expect(await readFile(join(local.state.root, jobKey), "utf8")).toBe(
        JSON.stringify(unknownJob),
      );
      expect(
        (await readFile(join(local.state.root, `space-${local.space.id}.json`))).equals(spaceBytes),
      ).toBe(true);
      await expect(readFile(local.observation + ".launches")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(join(local.policy.runtime.storageRoot, "runtime", "keychain-current.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const release = await local.state.lock();
      await release();
    },
  );
  vmTest.each(["confirmation", "runner-lock", "live-owner", "live-owner-stale-marker"] as const)(
    "explicit device recovery refuses %s without touching live peers or the orphan receipt",
    async (reason) => {
      const local = await fixture();
      local.policy.enabled = false;
      await local.state.write("policy.json", local.policy);
      const receipt = {
        owner: randomUUID(),
        profile: createHash("sha256")
          .update(
            JSON.stringify({ deviceId: local.policy.deviceId, runtime: local.policy.runtime }),
          )
          .digest("hex"),
        settled: false,
        ...(reason.startsWith("live-owner") ? { ownerPID: process.pid } : {}),
      };
      await local.state.write("runtime-owner.json", receipt);
      const release = reason === "runner-lock" ? await local.state.lock() : undefined;
      if (reason === "live-owner-stale-marker") {
        const child = spawn(process.execPath, ["-e", ""]);
        await once(child, "close");
        await writeFile(join(local.state.root, "runner.lock"), String(child.pid), { mode: 0o600 });
      }
      try {
        const readMarker = async (): Promise<Buffer | null> =>
          readFile(join(local.state.root, "runner.lock")).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
        const markerBefore = await readMarker();
        const args = [
          join(root, "cli.js"),
          "recover",
          ...(reason === "confirmation" ? [] : ["--confirm"]),
          "--state",
          local.state.root,
        ];
        const expectedCode =
          reason === "confirmation"
            ? "LOCAL_RECOVERY_CONFIRM"
            : reason === "runner-lock"
              ? "LOCAL_ALREADY_RUNNING"
              : "LOCAL_OWNER_ACTIVE";
        await expect(execute(process.execPath, args)).rejects.toMatchObject({
          stderr: expect.stringContaining(expectedCode),
        });
        expect(daemons[0].exitCode).toBeNull();
        expect(daemons[0].signalCode).toBeNull();
        expect(await local.state.read("runtime-owner.json", (value) => value)).toEqual(receipt);
        expect(await readMarker()).toEqual(markerBefore);
      } finally {
        await release?.();
      }
    },
  );
  vmTest.each(["daemon-retired", "lease-expired"] as const)(
    "a controlled stopped inventory read refuses %s before accepting its result",
    async (reason) => {
      const local = await fixture(false, true);
      await addStaleVmSocket(local);
      await writeFile(local.observation, JSON.stringify({ status: "stopped" }));
      await writeFile(local.observation + ".inventory-wait", "wait");
      const readiness = observeInventoryRead(local.observation + ".inventory-entered");
      const driver = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import {pathToFileURL} from 'node:url';
        const {startGuard} = await import(pathToFileURL(process.argv[2]).href);
        await startGuard(process.argv[3]).then(device=>device.stop().then(()=>{throw new Error('Retired inventory accepted');}),error=>{if(error.code!==process.argv[4])throw error;});
      `,
          "inventory-driver",
          join(root, "guard.js"),
          local.state.root,
          reason === "daemon-retired" ? "LOCAL_CONTROL_RETIRED" : "LOCAL_NOT_RUNNING",
        ],
        { env: {}, stdio: ["ignore", "pipe", "pipe"] },
      );
      daemons.push(driver);
      let stderr = "";
      driver.stderr!.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const closed = once(driver, "close");
      await readiness.wait(driver, () => stderr);
      if (reason === "daemon-retired") {
        const daemon = daemons[0];
        const exited = once(daemon, "close");
        daemon.kill("SIGTERM");
        await exited;
      } else {
        local.policy.leaseUntil = Date.now() - 1;
        await local.state.write("policy.json", local.policy);
      }
      await writeFile(local.observation + ".inventory-release", "release");
      expect({ exitCode: (await closed)[0], stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(await readFile(local.observation + ".daemon-stopped", "utf8")).toBe("stopped");
      await expect(readFile(local.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(local.observation + ".launches")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  vmTest(
    "parent death cancels the tracked inventory child before independent kernel closure",
    async () => {
      const local = await fixture(false, true);
      await addStaleVmSocket(local);
      await writeFile(local.observation, JSON.stringify({ status: "stopped" }));
      await writeFile(local.observation + ".inventory-wait", "wait");
      const driver = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import {startGuard} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      await startGuard(${JSON.stringify(local.state.root)});
    `,
        ],
        { env: {}, stdio: ["ignore", "pipe", "pipe"] },
      );
      daemons.push(driver);
      await waitFor(() =>
        readFile(local.observation + ".inventory-entered").then(
          () => true,
          () => false,
        ),
      );
      const inventory = JSON.parse(
        await readFile(local.observation + ".inventory-entered", "utf8"),
      );
      const exited = once(driver, "close");
      driver.kill("SIGKILL");
      await exited;
      await waitFor(async () => {
        try {
          return (
            JSON.parse(await readFile(join(local.state.root, "runtime-owner.json"), "utf8"))
              .settled === true
          );
        } catch {
          return false;
        }
      });
      expect(() => process.kill(inventory.pid, 0)).toThrow();
      expect(await readFile(local.observation + ".daemon-stopped", "utf8")).toBe("stopped");
      await expect(readFile(local.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  vmTest(
    "stopped SDK inventory permits stale sockets under the captured daemon and is not cached",
    async () => {
      const local = await fixture(false, true);
      await addStaleVmSocket(local);
      await writeFile(local.observation, JSON.stringify({ status: "stopped" }));
      await execute(process.execPath, [
        "--input-type=module",
        "-e",
        `
      import {startGuard} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      import fs from 'node:fs/promises';
      const device=await startGuard(${JSON.stringify(local.state.root)});
      const rows=await device.observe();
      if(rows.length!==1||rows[0].status!=='stopped')throw new Error('Stopped inventory changed');
      await fs.writeFile(${JSON.stringify(local.observation)},JSON.stringify({status:'running'}));
      await device.observe().then(()=>{throw new Error('Cached stopped inventory admitted running VM');},error=>{if(error.code!=='LOCAL_CONTROL_WORKER_UNVERIFIED')throw error;});
      await device.stop().catch(()=>{});
    `,
      ]);
      expect(await readFile(local.observation + ".daemon-stopped", "utf8")).toBe("stopped");
      await expect(readFile(local.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(local.observation + ".launches")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  vmTest.each(["mixed", "unknown", "empty", "malformed", "duplicate"] as const)(
    "stale sockets refuse %s inventory without guest work or a second daemon launch",
    async (variant) => {
      const local = await fixture();
      await addStaleVmSocket(local);
      const row = {
        id: "external-runtime-identity",
        name: local.space.name,
        agent: "shell",
        status: "stopped",
      };
      const rows =
        variant === "mixed"
          ? [row, { ...row, id: "peer", name: "peer", status: "starting" }]
          : variant === "unknown"
            ? [{ ...row, status: "mystery" }]
            : variant === "empty"
              ? []
              : variant === "duplicate"
                ? [row, row]
                : [row];
      await writeFile(
        local.observation + ".inventory",
        variant === "malformed" ? "not-json" : JSON.stringify({ sandboxes: rows }),
      );
      await execute(process.execPath, [
        "--input-type=module",
        "-e",
        `
        import {startGuard} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
        await startGuard(${JSON.stringify(local.state.root)}).then(device=>device.stop().then(()=>{throw new Error('Unverified inventory admitted');}),error=>{if(error.code!=='LOCAL_CONTROL_WORKER_UNVERIFIED')throw error;});
      `,
      ]);
      expect(await readFile(local.observation + ".daemon-stopped", "utf8")).toBe("stopped");
      await expect(readFile(local.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(local.observation + ".launches")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
  vmTest(
    "two-pass capture admits the exact live worker while old stale sockets remain, without a second SDK launch",
    async () => {
      const local = await fixture();
      await addStaleVmSocket(local);
      await execute(process.execPath, [
        "--input-type=module",
        "-e",
        `
      import {startGuard} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      const device=await startGuard(${JSON.stringify(local.state.root)});
      await device.observe();await device.stop();
    `,
      ]);
      await expect(readFile(local.observation + ".launches")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(local.observation + ".daemon-stopped", "utf8")).toBe("stopped");
      expect(await local.records.get(local.space.id)).toMatchObject({
        runtimeId: local.space.runtimeId,
        desiredState: "stopped",
      });
    },
  );
  test("credential recovery refuses enabled policy without touching its live SDK peer", async () => {
    const local = await fixture();
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import {prepareLocalCredentialRecovery} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      import {PrivateState} from ${JSON.stringify(`file://${join(root, "private-state.js")}`)};
      import {LocalRecords} from ${JSON.stringify(`file://${join(root, "space-record.js")}`)};
      const records=new LocalRecords(await PrivateState.open(${JSON.stringify(local.state.root)}));
      const release=await records.state.lock();try{
        await prepareLocalCredentialRecovery(records).then(()=>{throw new Error('Enabled SDK recovery was admitted');},error=>{if(error.code!=='LOCAL_DISABLED_REQUIRED')throw error;});
      }finally{await release();}
    `,
    ]);
    expect(daemons[0].exitCode).toBeNull();
    expect(daemons[0].signalCode).toBeNull();
  });

  test("credential recovery accepts a fresh absent peer set without SDK or credential calls", async () => {
    const local = await fixture(true);
    const daemon = daemons[0];
    const closed = once(daemon, "close");
    daemon.kill("SIGTERM");
    await closed;
    local.policy.enabled = false;
    await local.state.write("policy.json", local.policy);
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import {prepareLocalCredentialRecovery} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      import {PrivateState} from ${JSON.stringify(`file://${join(root, "private-state.js")}`)};
      import {LocalRecords} from ${JSON.stringify(`file://${join(root, "space-record.js")}`)};
      const records=new LocalRecords(await PrivateState.open(${JSON.stringify(local.state.root)}));
      const release=await records.state.lock();try{await prepareLocalCredentialRecovery(records);}finally{await release();}
    `,
    ]);
    expect(await local.state.read("runtime-owner.json", (value) => value)).toMatchObject({
      settled: true,
    });
    await expect(
      readFile(join(local.policy.runtime.storageRoot, "runtime", "keychain-current.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(local.observation + ".launches")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("credential recovery freshly stops a revived own peer despite an older settled receipt", async () => {
    const local = await fixture();
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import {withLocalRuntimeOwner} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      import {PrivateState} from ${JSON.stringify(`file://${join(root, "private-state.js")}`)};
      import {LocalRecords} from ${JSON.stringify(`file://${join(root, "space-record.js")}`)};
      const records=new LocalRecords(await PrivateState.open(${JSON.stringify(local.state.root)}));await withLocalRuntimeOwner(records,'doctor');
    `,
    ]);
    local.policy.enabled = false;
    await local.state.write("policy.json", local.policy);
    const namespace = `moira-${local.policy.deviceId.replaceAll("-", "").slice(0, 14)}`;
    const peer = spawn(
      local.policy.runtime.binary,
      [
        "--fixture-daemon",
        join(
          local.policy.runtime.storageRoot,
          "runtime",
          ".sbx",
          `run_${namespace}`,
          "d",
          "sandboxd.sock",
        ),
      ],
      { env: {}, stdio: ["ignore", "pipe", "pipe"] },
    );
    daemons.push(peer);
    expect((await once(peer.stdout!, "data"))[0].toString()).toBe("ready\n");
    const closed = once(peer, "close");
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import {prepareLocalCredentialRecovery} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      import {PrivateState} from ${JSON.stringify(`file://${join(root, "private-state.js")}`)};
      import {LocalRecords} from ${JSON.stringify(`file://${join(root, "space-record.js")}`)};
      const records=new LocalRecords(await PrivateState.open(${JSON.stringify(local.state.root)}));
      const release=await records.state.lock();try{await prepareLocalCredentialRecovery(records);}finally{await release();}
    `,
    ]);
    expect((await closed)[0]).toBe(0);
    expect(await local.state.read("runtime-owner.json", (value) => value)).toMatchObject({
      settled: true,
    });
  });
  test.each(["disabled", "expired"] as const)(
    "local diagnostics cannot restart a stopped SDK when policy is %s",
    async (reason) => {
      const local = await fixture();
      const daemon = daemons[0];
      const closed = once(daemon, "close");
      daemon.kill("SIGTERM");
      await closed;
      if (reason === "disabled") local.policy.enabled = false;
      else local.policy.leaseUntil = Date.now() - 1;
      await local.state.write("policy.json", local.policy);
      await execute(process.execPath, [
        "--input-type=module",
        "-e",
        `
      import {withLocalRuntimeOwner,prepareLocalCredentialRecovery} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      import {PrivateState} from ${JSON.stringify(`file://${join(root, "private-state.js")}`)};
      import {LocalRecords} from ${JSON.stringify(`file://${join(root, "space-record.js")}`)};
      const records=new LocalRecords(await PrivateState.open(${JSON.stringify(local.state.root)}));
      await withLocalRuntimeOwner(records,'doctor').then(()=>{throw new Error('Retired policy restarted SDK');},error=>{if(error.code!=='LOCAL_NOT_RUNNING')throw error;});
      if(${JSON.stringify(reason)}==='disabled'){
        const release=await records.state.lock();
        try{await prepareLocalCredentialRecovery(records);}finally{await release();}
      }
    `,
      ]);
      await expect(readFile(local.observation + ".launches")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await local.state.read("runtime-owner.json", (value) => value)).toMatchObject({
        settled: true,
      });
    },
  );

  test("an enabled owner reopens a stopped SDK through fixed foreground ownership and settles it", async () => {
    const local = await fixture();
    const daemon = daemons[0];
    const closed = once(daemon, "close");
    daemon.kill("SIGTERM");
    await closed;
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import {startGuard} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      const device=await startGuard(${JSON.stringify(local.state.root)});
      try{const rows=await device.observe();if(rows.length!==1||rows[0].status!=='stopped')throw new Error('Observation changed guest lifecycle');}
      finally{await device.stop();}
    `,
    ]);
    expect((await readFile(local.observation + ".launches", "utf8")).trim()).toBe("launched");
    expect(await local.state.read("runtime-owner.json", (value) => value)).toMatchObject({
      settled: true,
    });
  });

  test("local initializer refusal preserves existing sandbox data and closes its captured SDK", async () => {
    const local = await fixture();
    local.policy.enabled = false;
    await local.state.write("policy.json", local.policy);
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import {withLocalRuntimeOwner} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      import {PrivateState} from ${JSON.stringify(`file://${join(root, "private-state.js")}`)};
      import {LocalRecords} from ${JSON.stringify(`file://${join(root, "space-record.js")}`)};
      const records=new LocalRecords(await PrivateState.open(${JSON.stringify(local.state.root)}));
      await withLocalRuntimeOwner(records,'setup').then(()=>{throw new Error('Nonempty SDK profile was initialized');},error=>{if(error.code!=='LOCAL_RUNTIME_NOT_EMPTY')throw error;});
    `,
    ]);
    expect(await local.records.get(local.space.id)).toEqual(local.space);
    expect(await readFile(local.observation + ".daemon-stopped", "utf8")).toBe("stopped");
    expect(await local.state.read("runtime-owner.json", (value) => value)).toMatchObject({
      settled: true,
    });
  });

  test("local empty initializer refreshes kernel ownership across restart then closes SDK", async () => {
    const local = await fixture(true);
    local.policy.enabled = false;
    await local.state.write("policy.json", local.policy);
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import {withLocalRuntimeOwner} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      import {PrivateState} from ${JSON.stringify(`file://${join(root, "private-state.js")}`)};
      import {LocalRecords} from ${JSON.stringify(`file://${join(root, "space-record.js")}`)};
      const records=new LocalRecords(await PrivateState.open(${JSON.stringify(local.state.root)}));
      const result=await withLocalRuntimeOwner(records,'setup');if(result.sandboxes!==0)throw new Error('Unexpected setup projection');
    `,
    ]);
    expect((await readFile(local.observation + ".launches", "utf8")).trim()).toBe("launched");
    expect(await local.state.read("runtime-owner.json", (value) => value)).toMatchObject({
      settled: true,
    });
    expect(await local.records.get(local.space.id)).toMatchObject({
      runtimeId: null,
      phase: "creating",
    });
  });

  test("live-lease credential refusal immediately retires the captured SDK instead of waiting expiry", async () => {
    const local = await fixture();
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      driver(local) +
        `
      import {SbxRuntime} from ${JSON.stringify(`file://${join(root, "sbx-runtime.js")}`)};
      const home=${JSON.stringify(join(local.policy.runtime.storageRoot, "runtime"))};
      if(process.platform==='darwin')await f.writeFile(home+'/keychain-current.json','{}');
      else await f.rename(${JSON.stringify(local.policy.runtime.binary)},${JSON.stringify(local.policy.runtime.binary + ".unavailable")});
      const policy=JSON.parse(await f.readFile(${JSON.stringify(join(local.state.root, "policy.json"))},'utf8'));
      await new SbxRuntime(policy).call(['daemon','stop']).then(()=>{throw new Error('Credentialful shutdown incorrectly succeeded');},()=>{});
      process.kill(${daemons[0].pid},0);
      await guard.operation(${JSON.stringify(job())}).then(()=>{throw new Error('Unsafe credentials admitted work');},()=>{});
      await device.stop();
    `,
    ]);
    expect(await local.state.read("runtime-owner.json", (value) => value)).toMatchObject({
      settled: true,
    });
    expect(await readFile(local.observation + ".daemon-stopped", "utf8")).toBe("stopped");
  });
  test("confirmed IPC stop durably closes admission and advances the space generation", async () => {
    const local = await fixture();
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import {startGuard} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      const device=await startGuard(${JSON.stringify(local.state.root)});
      const guard=await device.space(${JSON.stringify(local.space.id)});
      await guard.stop();await device.stop();
    `,
    ]);
    expect(JSON.parse(await readFile(local.observation, "utf8"))).toEqual({ status: "stopped" });
    expect(await local.records.get(local.space.id)).toMatchObject({
      desiredState: "stopped",
      phase: "stopped",
      generation: local.space.generation + 1,
    });
  });

  vmTest(
    "an unknown guest response fences only its own durable space and settles its worker while a peer remains admitted",
    async () => {
      const local = await fixture();
      const peer = await addPeer(local);
      await writeFile(local.observation + ".guest-unknown", "unknown");
      await execute(process.execPath, [
        "--input-type=module",
        "-e",
        driver(local) +
          `
      const other=await device.space(${JSON.stringify(peer.id)});
      try {
        await guard.operation(${JSON.stringify(job())}).then(()=>{throw new Error('Unknown guest incorrectly succeeded');},error=>{if(error.code!=='LOCAL_GUEST_SETTLEMENT_UNKNOWN')throw error;});
        const own=JSON.parse(await f.readFile(spacePath,'utf8'));
        if(own.phase!=='stopped'||own.desiredState!=='stopped'||own.failure!=='LOCAL_GUEST_SETTLEMENT_UNKNOWN'||own.generation!==2)throw new Error('Unknown outcome lost its durable fence or confirmed stop');
        await guard.operation(${JSON.stringify(job())}).then(()=>{throw new Error('Fenced guest reexecuted');},()=>{});
        await other.validate();
        const row=JSON.parse(await f.readFile(${JSON.stringify(local.observation + ".peers")},'utf8'))[0];
        if(row.status!=='running')throw new Error('Unknown guest stopped a sibling VM');
      }finally{await device.stop();}
    `,
      ]);
      expect(await local.records.get(local.space.id)).toMatchObject({
        phase: "stopped",
        desiredState: "stopped",
        failure: "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
        generation: 2,
      });
      expect(await local.records.get(peer.id)).toMatchObject({ phase: "stopped", generation: 2 });
    },
  );

  vmTest(
    "explicit local recovery retains unknown job markers and opens a verified stopped VM's new generation",
    async () => {
      const local = await fixture();
      await writeFile(local.observation + ".guest-unknown", "unknown");
      const marker = `job-${"b".repeat(64)}.json`;
      const journal = { unknown: true, terminal: false, marker: "moira-op-" + "b".repeat(32) };
      await local.state.write(marker, journal);
      await execute(process.execPath, [
        "--input-type=module",
        "-e",
        driver(local) +
          `
      try {
        await guard.operation(${JSON.stringify(job())}).then(()=>{throw new Error('Unknown guest incorrectly succeeded');},error=>{if(error.code!=='LOCAL_GUEST_SETTLEMENT_UNKNOWN')throw error;});
        await device.space(${JSON.stringify(local.space.id)},true).then(()=>{throw new Error('Cloud start removed unknown fence');},error=>{if(error.code!=='LOCAL_GUEST_SETTLEMENT_UNKNOWN')throw error;});
        const generation=await device.recover(${JSON.stringify(local.space.id)},2);
        if(generation!==3)throw new Error('Recovery did not open a new local generation');
        const recovered=JSON.parse(await f.readFile(spacePath,'utf8'));
        if(recovered.phase!=='stopped'||recovered.failure!==null||recovered.generation!==3||recovered.recoveryGeneration!==3)throw new Error('Recovery lost its local acknowledgement');
        await f.unlink(${JSON.stringify(local.observation + ".guest-unknown")});
        const next=await device.space(${JSON.stringify(local.space.id)},true);
        await next.prepare();await next.validate();
      }finally{await device.stop();}
    `,
      ]);
      expect(JSON.parse(await readFile(join(local.state.root, marker), "utf8"))).toEqual(journal);
      expect(await local.records.get(local.space.id)).toMatchObject({
        phase: "stopped",
        desiredState: "stopped",
        failure: null,
        generation: 5,
        recoveryGeneration: 5,
      });
    },
  );

  vmTest(
    "local recovery refuses a running VM without clearing its retained unknown outcome",
    async () => {
      const local = await fixture();
      Object.assign(local.space, {
        desiredState: "stopped",
        phase: "stopped",
        failure: "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
      });
      await local.records.put(local.space);
      await execute(process.execPath, [
        "--input-type=module",
        "-e",
        `
      import {startGuard} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      import * as f from 'node:fs/promises';
      const device=await startGuard(${JSON.stringify(local.state.root)});
      try {
        await device.recover(${JSON.stringify(local.space.id)},1).then(()=>{throw new Error('Running recovery was accepted');},error=>{if(error.code!=='LOCAL_STOP_PENDING')throw error;});
        const record=JSON.parse(await f.readFile(${JSON.stringify(join(local.state.root, `space-${local.space.id}.json`))},'utf8'));
        if(record.failure!=='LOCAL_GUEST_SETTLEMENT_UNKNOWN'||record.generation!==1)throw new Error('Refused recovery cleared the fence');
      }finally{await device.stop();}
    `,
      ]);
    },
  );

  test("IPC shutdown kills an outstanding native exec before it can auto-start the stopped sandbox", async () => {
    const local = await fixture();
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      driver(local) +
        `
      const work=guard.operation(${JSON.stringify(job())});
      try{await Promise.race([wait(),work.then(()=>{throw new Error('Operation completed before barrier');})]);}
      catch(error){await guard.stop();await device.stop();throw error;}
      const settled=work.then(()=>false,()=>true);
      await guard.stop();await device.stop();if(!await settled)throw new Error('Interrupted work incorrectly succeeded');
    `,
    ]);
    const { pid } = JSON.parse(await readFile(local.pending, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    await writeFile(local.release, "resume");
    await expect(readFile(local.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(local.observation, "utf8"))).toEqual({ status: "stopped" });
  });

  test("parent death shuts down the outstanding native exec and closes its durable admission", async () => {
    const local = await fixture();
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      driver(local) +
        `
      const work=guard.operation(${JSON.stringify(job())});
      try{await Promise.race([wait(),work.then(()=>{throw new Error('Operation completed before barrier');})]);}
      catch(error){await guard.stop();await device.stop();throw error;}
      process.exit(0);
    `,
    ]);
    await waitFor(
      async () =>
        JSON.parse(await readFile(local.observation, "utf8")).status === "stopped" &&
        (await local.records.get(local.space.id))?.phase === "stopped",
    );
    const { pid } = JSON.parse(await readFile(local.pending, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await local.records.get(local.space.id)).toMatchObject({
      desiredState: "stopped",
      phase: "stopped",
      generation: 2,
    });
    await writeFile(local.release, "resume");
    await expect(readFile(local.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("an interrupted creation keeps unknown identity and stops the dedicated daemon without adopting a same-name VM", async () => {
    const local = await fixture(true);
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      driver(local) +
        `
      const work=guard.prepare();
      try{await Promise.race([wait(),work.then(()=>{throw new Error('Creation completed before barrier');})]);}
      catch(error){await guard.stop();await device.stop();throw error;}
      const settled=work.catch(()=>{});await guard.stop();await settled;
    `,
    ]);
    const { pid } = JSON.parse(await readFile(local.pending, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await local.records.get(local.space.id)).toMatchObject({
      runtimeId: null,
      desiredState: "stopped",
      phase: "failed",
      failure: "LOCAL_CREATE_UNKNOWN",
      generation: 2,
    });
    expect(JSON.parse(await readFile(local.observation, "utf8"))).toEqual({ status: "stopped" });
  });

  test("lease expiry cancels an admitted native exec and prevents later work without parent cooperation", async () => {
    const local = await fixture();
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      driver(local) +
        `
      const work=guard.operation(${JSON.stringify(job())});
      try{await Promise.race([wait(),work.then(()=>{throw new Error('Operation completed before barrier');})]);}
      catch(error){await guard.stop();await device.stop();throw error;}
      const policyPath=${JSON.stringify(join(local.state.root, "policy.json"))};
      const policy=JSON.parse(await f.readFile(policyPath,'utf8'));policy.leaseUntil=Date.now();
      await f.writeFile(policyPath,JSON.stringify(policy));
      await work.then(()=>{throw new Error('Expired native operation succeeded');},()=>{});
      await guard.stop();
      await guard.operation(${JSON.stringify(job())}).then(()=>{throw new Error('Expired owner accepted new work');},()=>{});
    `,
    ]);
    const { pid } = JSON.parse(await readFile(local.pending, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await local.records.get(local.space.id)).toMatchObject({
      desiredState: "stopped",
      phase: "stopped",
      generation: 2,
    });
    expect(JSON.parse(await readFile(local.observation, "utf8"))).toEqual({ status: "stopped" });
  });

  test("lease expiry stops the captured runtime after credentials and the SDK command path become unusable", async () => {
    const local = await fixture();
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      driver(local) +
        `
      const work=guard.operation(${JSON.stringify(job())});const settled=work.catch(()=>{});
      try{await Promise.race([wait(),work]);
        const home=${JSON.stringify(join(local.policy.runtime.storageRoot, "runtime"))};
        if(process.platform==='darwin')await f.writeFile(home+'/keychain-current.json','{}');
        await f.rename(${JSON.stringify(local.policy.runtime.binary)},${JSON.stringify(local.policy.runtime.binary + ".unavailable")});
        const p=${JSON.stringify(join(local.state.root, "policy.json"))};
        const policy=JSON.parse(await f.readFile(p,'utf8'));policy.leaseUntil=Date.now();await f.writeFile(p,JSON.stringify(policy));
        await settled;await device.stop().then(()=>{throw new Error('Unverifiable SDK path reported settled closure');},error=>{if(!['LOCAL_STOP_PENDING','LOCAL_GUARD_UNAVAILABLE'].includes(error.code))throw error;});
      }finally{await device.stop().catch(()=>{});await settled;}
    `,
    ]);
    const { pid } = JSON.parse(await readFile(local.pending, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await local.state.read("runtime-owner.json", (value) => value)).toMatchObject({
      settled: false,
    });
    expect(await local.records.get(local.space.id)).toMatchObject({
      desiredState: "stopped",
      phase: "failed",
      failure: "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
      generation: 2,
    });
    expect(await readFile(local.observation + ".daemon-stopped", "utf8")).toBe("stopped");
    await writeFile(local.release, "resume");
    await expect(readFile(local.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("stopping one space preserves an admitted peer's native exec until device shutdown", async () => {
    const local = await fixture();
    const peer = await addPeer(local);
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      driver(local) +
        `
      const other=await device.space(${JSON.stringify(peer.id)});
      const work=other.operation(${JSON.stringify(job())});
      const settled=work.catch(()=>{});
      try{await Promise.race([wait(),work]);await guard.stop();
        const {pid}=JSON.parse(await f.readFile(${JSON.stringify(local.pending + "." + peer.name)},'utf8'));process.kill(pid,0);
      }finally{await device.stop();await settled;}
    `,
    ]);
    expect(await local.records.get(local.space.id)).toMatchObject({
      desiredState: "stopped",
      generation: 2,
    });
    expect(await local.records.get(peer.id)).toMatchObject({
      desiredState: "stopped",
      phase: "stopped",
      generation: 2,
    });
  });

  test("unknown creation emergency cancels peer native children before stopping the shared device daemon", async () => {
    const local = await fixture(true);
    const peer = await addPeer(local);
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      driver(local) +
        `
      const other=await device.space(${JSON.stringify(peer.id)});
      const peerWork=other.operation(${JSON.stringify(job())});const peerSettled=peerWork.catch(()=>{});
      await Promise.race([wait(),peerWork]);
      await f.unlink(${JSON.stringify(local.pending)});
      const creating=guard.prepare();const settled=creating.catch(()=>{});
      try{await Promise.race([wait(),creating]);await guard.stop();}
      finally{await device.stop();await settled;await peerSettled;}
    `,
    ]);
    for (const name of [local.space.name, peer.name]) {
      const { pid } = JSON.parse(await readFile(local.pending + "." + name, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    }
    expect(await local.records.get(local.space.id)).toMatchObject({
      runtimeId: null,
      phase: "failed",
      failure: "LOCAL_CREATE_UNKNOWN",
      generation: 2,
    });
    expect(await local.records.get(peer.id)).toMatchObject({
      desiredState: "stopped",
      phase: "stopped",
      generation: 2,
    });
    expect(await readFile(local.observation + ".daemon-stopped", "utf8")).toBe("stopped");
  });

  test("local emergency disable waits for the owner receipt after cancelling an outstanding SDK call", async () => {
    const local = await fixture();
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      driver(local) +
        `
      import {stopLocalDevice} from ${JSON.stringify(`file://${join(root, "guard.js")}`)};
      import {PrivateState} from ${JSON.stringify(`file://${join(root, "private-state.js")}`)};
      import {LocalRecords} from ${JSON.stringify(`file://${join(root, "space-record.js")}`)};
      const work=guard.operation(${JSON.stringify(job())});const settled=work.catch(()=>{});
      try{await Promise.race([wait(),work]);
        const records=new LocalRecords(await PrivateState.open(${JSON.stringify(local.state.root)}));
        const policy=await records.policy();policy.enabled=false;await records.state.write('policy.json',policy);
        await stopLocalDevice(records);
      }finally{await device.stop();await settled;}
    `,
    ]);
    const { pid } = JSON.parse(await readFile(local.pending, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await local.state.read("runtime-owner.json", (value) => value)).toMatchObject({
      settled: true,
    });
    expect(await local.records.get(local.space.id)).toMatchObject({
      desiredState: "stopped",
      phase: "stopped",
      generation: 2,
    });
    expect(await readFile(local.observation + ".daemon-stopped", "utf8")).toBe("stopped");
  });

  test("a stopped space is activated by the owner and its prior admission cannot dispatch after restart", async () => {
    const local = await fixture();
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      driver(local) +
        `
      try{await guard.stop();
        const fresh=await device.space(${JSON.stringify(local.space.id)},true);
        await fresh.prepare();
        await guard.operation(${JSON.stringify(job())}).then(()=>{throw new Error('Prior admission executed after restart');},()=>{});
        const current=JSON.parse(await f.readFile(spacePath,'utf8'));
        if(current.generation!==3||current.desiredState!=='running'||current.phase!=='usable')throw new Error('Owner activation lost the authoritative generation');
      }finally{await device.stop();}
    `,
    ]);
    expect(await local.records.get(local.space.id)).toMatchObject({
      desiredState: "stopped",
      phase: "stopped",
      generation: 4,
    });
    expect(JSON.parse(await readFile(local.observation, "utf8"))).toEqual({ status: "stopped" });
  });
});
