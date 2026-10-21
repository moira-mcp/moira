# System Restart

## What to do

1. Stop all development processes (dev:all, dev:mcp, dev:backend, dev:frontend)
2. Run `npm run docker:restart`
3. Wait for the script to finish

## Verifying correctness

The script exiting with exit code 0 means the system started correctly.

The source development launcher restarts the application container. Supported public self-host
Compose starts the application and static Traefik ingress with `docker compose up -d`; keep
`config/traefik-self-host.yml` installed so workspace Upgrade streams reach backend 3001.

Moira Local is a separate owner-controlled host process. An app restart or `local:build` does not
replace its live owner or initialized SDK state. `npm run local -- install` stages a complete
immutable executable closure while the active owner continues. Inspect `service-status`; select a
staged physical-owner update only through explicit `maintenance --confirm` within an approved
interruption, then collect its printed original request identity. Exact settlement must precede
replacement. Preserve the same private state, SDK profile, backing storage, grants and VM disks;
per-VM recovery results do not replay commands. Login startup after a Mac reboot also requires
available storage/runtime/credentials and cannot preserve the previous guest boot.
See [Local owner updates](../CODESPACES.md#owner-web-control-and-bundle-updates) for pause/resume,
uncertain maintenance and first-cutover constraints. Existing guest workspace payloads are updated through fixed
provider bootstrap in place; no replacement VM or re-enrollment is required.
