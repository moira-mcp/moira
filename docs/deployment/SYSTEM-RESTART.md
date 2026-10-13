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
replace its live owner or initialized SDK state. Coordinate shutdown before selecting a complete
immutable companion executable release, then restart with the same private state, SDK profile,
backing storage, grants and VM disks. Existing guest workspace payloads are updated through fixed
provider bootstrap in place; no replacement VM or re-enrollment is required.
