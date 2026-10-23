# HTTP load testing

Use the existing k6 scenarios against an explicitly authorized disposable test installation.
The runner is [scripts/run-load-testing.sh](../scripts/run-load-testing.sh); it starts the local
InfluxDB/Grafana stack, may open a browser and creates test users for authenticated workloads.
Inspect the host port inventory before starting those listeners. Its default metrics ports are
Grafana 3033 and InfluxDB 8087, defined by [Compose](docker-compose.k6.yml); do not clear another
service's port or storage to run this stack.

## Select a target and scenario

From the repository root:

```bash
./scripts/run-load-testing.sh --help
# After preparing and authorizing the selected test target:
TARGET_BASE_URL=http://host.docker.internal:YOUR_TEST_PORT \
  ./scripts/run-load-testing.sh local workflows --no-dashboard
```

`local` uses `TARGET_BASE_URL` or the runner's existing container-visible default
`http://host.docker.internal:3032`. `staging` requires `STAGING_BASE_URL`; `prod` requires
`PROD_BASE_URL` and displays a five-second warning. Selecting a name or waiting through that
warning does not grant authorization to load a shared or production service. The runner reads
the selected URL/secret variables from `.env.local`; do not commit that file.

| Scenario         | Current observation                                                             |
| ---------------- | ------------------------------------------------------------------------------- |
| `health`         | Public `/api/health` readiness and response timing                              |
| `auth`           | Test signup, session/current-user and authenticated workflow reads              |
| `workflows`      | Workflow lists, public/private/search filters and available public details      |
| `executions`     | Execution lists, running/completed filters and the accepted waiting alias       |
| `settings`       | Selected settings reads and updates; inspect the scenario before use            |
| `full`           | Mixed health, workflow, execution-list, settings and profile reads              |
| `stress`, `soak` | Their authored high/sustained virtual-user HTTP workloads                       |
| `rate-limit`     | Public `/api/features` requests without bypass, expecting the API limiter's 429 |

These HTTP workloads do not exercise MCP transport or start/step executions. A fresh user's
empty private-workflow or execution list is valid. The management API's `status=waiting` is a
compatibility alias for `running`, not an input-wait-only filter.

`--vus N` and `--duration T` forward k6 CLI options; the scenario's authored `options.scenarios`
still owns its executor/stages. `--no-dashboard` suppresses browser opening, not metrics-stack
startup. Stop the owned metrics services when finished using the existing Compose definition;
keep its volumes when results must be retained. The runner leaves the metrics stack running.

## Prepare authenticated admission on the backend

The target server must have `ENABLE_LOAD_TEST_AUTH=true` and a configured `LOAD_TEST_SECRET`
of at least 16 characters. Give the k6 client that same secret through its environment. The
shared helper creates unique `@load-testing-noverify.local` users and sends `X-Load-Test`.
This narrowly enables the backend's load-test email-verification bypass; a matching secret alone
does not enable it. Other deployment/account approval gates still apply. The server's chosen
configuration must admit the owned fixture accounts; signup 200 alone is not proof of product access.

These are **target backend** settings. Adding an environment variable only to a client command
does not reconfigure a running server. Read [configuration](../docs/operator/configuration.md)
and the actual [auth helper](k6/lib/auth.js). Test accounts are not automatically deleted by these
scenarios; own their cleanup in the disposable installation.

With a real email provider, recipient suppression additionally requires the backend's explicit
`EMAIL_TEST_RECIPIENTS=true`. `EMAIL_PROVIDER=test` logs instead of sending; logged delivery is
not real delivery. Use the [test preparation guide](../tests/docs/api-mcp-testing.md).

Do not print the secret or dump environment files to diagnose admission. Check its presence only:

```bash
test -n "${LOAD_TEST_SECRET:-}" && printf 'Client load-test secret is set\n'
```

Confirm the target flags through its authorized configuration owner. A valid `X-Load-Test` can
also bypass ordinary API/auth limiters; this is separate from authentication admission.

## Rate-limit observation

Use an isolated target with `DISABLE_RATE_LIMIT=false`, ordinary production-style limiter policy,
and no whitelist for the requesting client address. The rate-limit scenario sends no bypass
header and requires `DISABLE_RATE_BYPASS=true` in k6. It observes only the mounted ordinary API
quota through `/api/features`; `/api/health` is an unlimited reachability check.

The runner supplies the no-bypass flag for `rate-limit`. For `local rate-limit` it also calls the
existing contributor Docker helper with `--rate-limit`, which rebuilds/restarts the selected local
container. Authorize that interruption and inspect its actual target/environment first. Remote
targets must already have the intended limiter configuration; the runner does not change them.
The default quota is 100 requests per client address per minute. Trust-proxy resolution, disabled
mode and whitelist settings affect which limit is observed; see the
[HTTP owner](../docs/reference/http-api.md#rate-limiting). The scenario's actual 429 checks and
thresholds decide its result, not a printed completion message.

## Profiles, thresholds and results

[config.js](k6/lib/config.js) owns the reusable `light`, `medium`, `heavy` and `soak` ramping
virtual-user profiles. Virtual users are not a fixed requests-per-second rate. Stress, soak and
rate-limit scenarios also declare their own executors and timing in source.

Each scenario's `options.thresholds` is the effective pass/fail configuration. The shared
[threshold library](k6/lib/thresholds.js) exports reusable budgets and generators; those values
apply only when consumed. They are configured comparison limits, not measured production
baselines, service-level promises or a deployment gate.

[docker-compose.k6.yml](docker-compose.k6.yml) mounts `k6/` read-only and connects it to InfluxDB;
[Grafana provisioning](grafana/provisioning/) loads the generic HTTP/VU dashboard. Inspect k6's
exit result, failed checks and metrics for the selected scenario. Preserve useful evidence at its
existing local owner; do not commit a pending measurement ledger or infer provider/MCP acceptance
from an HTTP read workload.
