import { describe, expect, test } from "@jest/globals";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { DEFAULT_TEMPLATE } from "../../../packages/local/src/config.js";

describe("guest Docker service inherited file limits", () => {
  test.each([
    {
      label: "raw proxy without credentials",
      proxy: "http://fixed-proxy",
      reported: "http://fixed-proxy|http://fixed-proxy",
      accepted: true,
    },
    {
      label: "exact raw credentialed proxy",
      proxy: "http://fixed-user:fixed-secret@127.0.0.1:3437",
      reported:
        "http://fixed-user:fixed-secret@127.0.0.1:3437|http://fixed-user:fixed-secret@127.0.0.1:3437",
      accepted: true,
    },
    {
      label: "Engine masked credentialed proxy",
      proxy: "http://fixed-user:fixed-secret@127.0.0.1:3437",
      reported: "http://xxxxx:xxxxx@127.0.0.1:3437|http://xxxxx:xxxxx@127.0.0.1:3437",
      accepted: true,
    },
    {
      label: "unexpected masked proxy origin",
      proxy: "http://fixed-user:fixed-secret@127.0.0.1:3437",
      reported: "http://xxxxx:xxxxx@127.0.0.1:3438|http://xxxxx:xxxxx@127.0.0.1:3438",
      accepted: false,
    },
    {
      label: "different HTTP and HTTPS proxies",
      proxy: "http://fixed-user:fixed-secret@127.0.0.1:3437",
      reported: "http://xxxxx:xxxxx@127.0.0.1:3437|http://xxxxx:xxxxx@other-proxy:3437",
      accepted: false,
    },
    {
      label: "stale credentials force a real service restart",
      proxy: "http://fixed-user:fixed-secret@127.0.0.1:3437",
      previousProxy: "http://old-user:old-secret@127.0.0.1:3437",
      initialReported: "http://xxxxx:xxxxx@127.0.0.1:3437|http://xxxxx:xxxxx@127.0.0.1:3437",
      reported: "http://xxxxx:xxxxx@127.0.0.1:3437|http://xxxxx:xxxxx@127.0.0.1:3437",
      accepted: true,
    },
  ])(
    "$label preserves parent ceilings and exact proxy admission",
    async ({ proxy, reported, accepted, previousProxy, initialReported }) => {
      const bundled = await build({
        entryPoints: ["packages/local/src/guest-docker.ts"],
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
        write: false,
      });
      // Substitute privileged configuration/service plumbing only. Both prlimit and
      // the vendor's failing ulimit operation execute through the real Linux kernel.
      const script = `
const fs=require('node:fs'),cp=require('node:child_process');
const source=fs.readFileSync(0,'utf8');
const root='/tmp/guest-limit';fs.mkdirSync(root+'/bin',{recursive:true});fs.mkdirSync(root+'/.local/share/moira-local',{recursive:true});
process.env.HOME=root;process.env.PATH=root+'/bin:/usr/bin:/bin';
fs.writeFileSync(root+'/docker.mjs',source);
const previousProxy=${JSON.stringify(previousProxy) ?? "undefined"};
if(previousProxy)fs.writeFileSync(root+'/installed.json',JSON.stringify({proxies:{'http-proxy':previousProxy,'https-proxy':previousProxy,'no-proxy':'localhost,127.0.0.1,::1'}}));
const executable=(name,text)=>fs.writeFileSync(root+'/bin/'+name,text,{mode:448});
executable('sudo', '#!/bin/sh\\n[ "$1" = "-n" ] || exit 40\\nshift\\ncase "$1" in cat) exec /bin/cat /tmp/guest-limit/installed.json ;; install) /bin/cp "$5" /tmp/guest-limit/installed.json ;; service|prlimit) exec "$@" ;; *) exit 41 ;; esac\\n');
executable('service', '#!/bin/sh\\n[ "$1" = "docker" ] && [ "$2" = "restart" ] || exit 42\\nprintf "%s|%s" "$(ulimit -Sn)" "$(ulimit -Hn)" > /tmp/guest-limit/before\\nulimit -Hn 524288 || exit $?\\nprintf "%s|%s" "$(ulimit -Sn)" "$(ulimit -Hn)" > /tmp/guest-limit/after\\n');
executable('docker', '#!/bin/sh\\ncase "$1" in info) if [ -f /tmp/guest-limit/after ]; then printf "%s" "${reported}"; else printf "%s" "${initialReported ?? "unset"}"; fi ;; network) printf "172.18.0.1" ;; *) exit 43 ;; esac\\n');
const limits=()=>cp.execFileSync('/bin/sh',['-c','printf "%s|%s" "$(ulimit -Sn)" "$(ulimit -Hn)"'],{encoding:'utf8'});
const parentBefore=limits();
const original=cp.spawnSync('service',['docker','restart'],{encoding:'utf8'});
if(original.status!==2 || !original.stderr.includes('Invalid argument'))throw Error('Original EINVAL was not reproduced: '+JSON.stringify({status:original.status,stderr:original.stderr,error:original.error?.code,parentBefore}));
fs.rmSync(root+'/before');
import('file://'+root+'/docker.mjs').then(async module=>{
 let accepted=true;
 try {await module.configureGuestDocker(${JSON.stringify(proxy)},'fixed-space','fixed-token');}
 catch(error) {if(error.message!=='Guest Docker did not adopt its restricted proxy')throw error;accepted=false;}
 process.stdout.write(JSON.stringify({accepted,originalExit:original.status,parentBefore,parentAfter:limits(),childBefore:fs.readFileSync(root+'/before','utf8'),childAfter:fs.readFileSync(root+'/after','utf8')}));
}).catch(error=>{console.error(error.code);process.exitCode=1});
`;
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            "docker",
            [
              "run",
              // Keep image-pull progress separate from the guest's asserted stderr.
              "--quiet",
              "--rm",
              "--interactive",
              "--network",
              "none",
              "--read-only",
              "--memory",
              "512m",
              "--cpus",
              "1",
              "--pids-limit",
              "64",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges",
              "--ulimit",
              "nofile=1048576:1048576",
              "--tmpfs",
              "/tmp:rw,exec,nosuid,nodev,mode=1777",
              "--entrypoint",
              "node",
              DEFAULT_TEMPLATE,
              "-e",
              script,
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (bytes) => {
            stdout += bytes;
          });
          child.stderr.on("data", (bytes) => {
            stderr += bytes;
          });
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, stdout, stderr }));
          child.stdin.end(bundled.outputFiles[0].text);
        },
      );
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        accepted,
        originalExit: 2,
        parentBefore: "1048576|1048576",
        parentAfter: "1048576|1048576",
        childBefore: "524288|1048576",
        childAfter: "524288|524288",
      });
    },
  );
});
