# Load Testing Infrastructure

This directory contains k6-based load testing infrastructure for MCP Moira with real-time Grafana dashboards.

## Quick Start

```bash
# Run health check against local Docker
./scripts/run-load-testing.sh local health

# Run full API test against staging
./scripts/run-load-testing.sh staging full

# Run stress test against production (5s safety warning)
./scripts/run-load-testing.sh prod stress
```

The CLI automatically:

- ✅ Starts InfluxDB + Grafana Docker stack if not running
- ✅ Opens Grafana dashboard in browser
- ✅ Runs k6 test with real-time metrics
- ✅ Handles graceful shutdown on Ctrl+C

## CLI Usage

```bash
./scripts/run-load-testing.sh <target> <scenario> [options]
```

### Targets

| Target    | URL                 | Description                        |
| --------- | ------------------- | ---------------------------------- |
| `local`   | localhost:3032      | Local Docker (default)             |
| `staging` | `$STAGING_BASE_URL` | Staging environment (requires env) |
| `prod`    | `$PROD_BASE_URL`    | Production (5s safety warning)     |

### Scenarios

| Scenario     | Description                          | VUs   | Duration |
| ------------ | ------------------------------------ | ----- | -------- |
| `health`     | Health endpoint validation           | 1-10  | 2m       |
| `auth`       | Authentication flow (register/login) | 1-10  | 2m       |
| `workflows`  | Workflow CRUD operations             | 1-50  | 5m       |
| `executions` | Execution management                 | 1-50  | 5m       |
| `settings`   | User settings operations             | 1-30  | 3m       |
| `full`       | Mixed workload (all endpoints)       | 1-100 | 10m      |
| `stress`     | High-load stress test                | 1-200 | 15m      |
| `soak`       | Long-running stability               | 50    | 30m      |
| `mcp`        | MCP tool patterns                    | 1-50  | 5m       |
| `rate-limit` | Rate limiting verification           | 20    | 10s      |

### Options

| Option           | Description                  | Example          |
| ---------------- | ---------------------------- | ---------------- |
| `--vus N`        | Override virtual users count | `--vus 100`      |
| `--duration T`   | Override test duration       | `--duration 10m` |
| `--no-dashboard` | Skip Grafana auto-open       | `--no-dashboard` |
| `--help`         | Show help message            | `--help`         |

### Examples

```bash
# Quick smoke test
./scripts/run-load-testing.sh local health

# Custom VUs and duration
./scripts/run-load-testing.sh local workflows --vus 50 --duration 5m

# Stress test without opening browser
./scripts/run-load-testing.sh staging stress --no-dashboard

# Soak test for stability
./scripts/run-load-testing.sh local soak
```

## Directory Structure

```
load-tests/
├── docker-compose.k6.yml      # k6 + InfluxDB + Grafana stack
├── k6/
│   ├── scenarios/             # k6 test scenarios (JS)
│   │   ├── health-check.js    # Health endpoint
│   │   ├── auth-test.js       # Authentication flow
│   │   ├── api-workflows.js   # Workflow operations
│   │   ├── api-executions.js  # Execution operations
│   │   ├── settings-api.js    # Settings operations
│   │   ├── full-api.js        # Mixed workload
│   │   ├── stress.js          # High-load stress
│   │   ├── soak.js            # Long-running stability
│   │   ├── mcp-tools.js       # MCP tool patterns
│   │   └── rate-limit-test.js # Rate limiting verification
│   └── lib/                   # Shared utilities
│       ├── config.js          # Environments, load profiles
│       ├── thresholds.js      # SLA thresholds
│       ├── auth.js            # Authentication helpers
│       ├── metrics.js         # Custom metrics
│       └── index.js           # Combined exports
├── grafana/
│   ├── dashboards/            # Pre-configured dashboards
│   └── provisioning/          # Auto-provisioning
├── BASELINES.md               # SLAs and performance targets
└── README.md                  # This file
```

## NPM Scripts

| Script                        | Description            |
| ----------------------------- | ---------------------- |
| `npm run loadtest`            | Run against Docker     |
| `npm run loadtest:staging`    | Run against staging    |
| `npm run loadtest:prod`       | Run against production |
| `npm run loadtest:stack:up`   | Start metrics stack    |
| `npm run loadtest:stack:down` | Stop metrics stack     |

```bash
# Quick run via npm
npm run loadtest -- health
npm run loadtest:staging -- stress
```

## Manual k6 Commands

If you prefer running k6 directly:

```bash
# Start metrics stack
cd load-tests
docker compose -f docker-compose.k6.yml up -d influxdb grafana

# Run test with InfluxDB output
docker compose -f docker-compose.k6.yml run --rm \
  -e TARGET_BASE_URL=http://host.docker.internal:3032 \
  k6 run /scripts/scenarios/health-check.js

# View dashboard
open http://localhost:3033  # Grafana (admin/admin)
```

## Authentication

Load tests use a special authentication domain that bypasses email verification.

### Setup

1. Set `LOAD_TEST_SECRET` environment variable (min 16 characters)
2. k6 creates users with `@load-testing-noverify.local` domain
3. Backend auto-verifies these users when secret matches

```bash
# Required for authenticated scenarios
export LOAD_TEST_SECRET=your-secret-minimum-16-chars

./scripts/run-load-testing.sh local workflows
```

### In Test Code

```javascript
import { registerTestUser, authGet } from "../lib/index.js";

export default function () {
  const session = registerTestUser();
  const response = authGet(apiUrl + "/user/me", session.cookies);
}
```

## Rate Limit Bypass

Load tests automatically bypass server rate limits using the `X-Load-Test` header when `LOAD_TEST_SECRET` is configured.

### How It Works

1. When `LOAD_TEST_SECRET` env var is set in k6, all HTTP requests include `X-Load-Test` header
2. Server validates header value against its `LOAD_TEST_SECRET` env var
3. If valid, request skips rate limiting checks

**Note:** The same `X-Load-Test` header is used for both authentication bypass and rate limit bypass.

### Testing Rate Limits

To verify rate limiting works correctly, use the `rate-limit-test` scenario with `DISABLE_RATE_BYPASS=true`:

```bash
# Against staging (with rate limiting enabled)
docker compose -f docker-compose.k6.yml --profile run run --rm \
  -e TARGET_BASE_URL=https://staging.example.com \
  -e DISABLE_RATE_BYPASS=true \
  k6 run /scripts/scenarios/rate-limit-test.js
```

**Note:** Local dev container has `DISABLE_RATE_LIMIT=true` which disables rate limiting entirely. Use staging/production to test rate limits.

### Rate Limits Reference

| Endpoint Type | Limit        | Description          |
| ------------- | ------------ | -------------------- |
| API           | 100 req/min  | `/api/*` routes      |
| Auth          | 1000 req/min | `/api/auth/*` routes |
| MCP           | 30 req/min   | `/mcp` route         |

## k6 Library Reference

### Configuration

```javascript
import { getApiUrl, getLoadProfile } from "../lib/index.js";

const apiUrl = getApiUrl(); // Based on TARGET_BASE_URL
const profile = getLoadProfile("light"); // Load profile config
```

### Thresholds

```javascript
import { getThresholdsForEndpoint } from "../lib/index.js";

// SLA thresholds from BASELINES.md
const thresholds = getThresholdsForEndpoint("healthCheck");
// { http_req_duration: ['p(50)<10', 'p(95)<20', 'p(99)<50'] }
```

## Environment Variables

| Variable              | Required      | Description                              |
| --------------------- | ------------- | ---------------------------------------- |
| `TARGET_BASE_URL`     | For local     | Target system URL                        |
| `STAGING_BASE_URL`    | For staging   | Staging environment URL                  |
| `PROD_BASE_URL`       | For prod      | Production environment URL               |
| `LOAD_TEST_SECRET`    | For auth      | Secret for test user + rate limit bypass |
| `LOAD_PROFILE`        | No            | Override profile: light/medium/heavy     |
| `DISABLE_RATE_BYPASS` | For rate test | Set to "true" to test rate limiting      |

**Security Note:** Production and staging URLs are NOT hardcoded. Provide via environment variables.

## Grafana Dashboard

Access at http://localhost:3033 (admin/admin):

- **RPS**: Requests per second over time
- **Response Time**: p50, p90, p95, p99 percentiles
- **Error Rate**: Failed requests percentage
- **Active VUs**: Virtual users over time
- **Status Codes**: HTTP response code distribution

## Load Profiles

### Light (Smoke Test)

- **VUs**: 1 → 10
- **Duration**: 2 minutes
- **Use Case**: Verify setup, quick checks

### Medium (Standard)

- **VUs**: 1 → 50
- **Duration**: 5-10 minutes
- **Use Case**: Performance baselines

### Heavy (Stress)

- **VUs**: 1 → 200
- **Duration**: 15-25 minutes
- **Use Case**: Stress testing, rate limits

### Soak

- **VUs**: 50 constant
- **Duration**: 30 minutes
- **Use Case**: Memory leaks, stability

## Performance Targets (SLAs)

See [BASELINES.md](./BASELINES.md) for detailed performance targets.

| Endpoint       | p50    | p95    | p99    | Success |
| -------------- | ------ | ------ | ------ | ------- |
| Health Check   | ≤10ms  | ≤20ms  | ≤50ms  | 100%    |
| Workflows API  | ≤50ms  | ≤150ms | ≤300ms | ≥99.9%  |
| Executions API | ≤75ms  | ≤200ms | ≤400ms | ≥99.9%  |
| MCP Tools      | ≤100ms | ≤300ms | ≤500ms | ≥99.5%  |
| Full System    | ≤100ms | ≤300ms | ≤600ms | ≥99%    |

## Troubleshooting

### Docker Stack Won't Start

```bash
# Check if ports are in use
lsof -i :3033  # Grafana
lsof -i :8087  # InfluxDB

# Force restart
cd load-tests
docker compose -f docker-compose.k6.yml down
docker compose -f docker-compose.k6.yml up -d influxdb grafana
```

### Connection Refused to localhost:3032

```bash
# Verify Moira is running
docker ps | grep mcp-moira-dev
curl http://localhost:3032/api/health
```

### No Data in Grafana

1. Check InfluxDB connection: Settings → Data Sources → k6
2. Verify k6 is sending metrics: Look for "output: InfluxDBv1" in k6 output
3. Check time range in Grafana dashboard

### Authentication Errors

```bash
# Verify secret is set
echo $LOAD_TEST_SECRET

# Check backend supports load test auth
grep LOAD_TEST_SECRET .env.local
```

## References

- [k6 Documentation](https://k6.io/docs/)
- [k6 Scenarios](https://k6.io/docs/using-k6/scenarios/)
- [InfluxDB Integration](https://k6.io/docs/results-output/real-time/influxdb/)
- [Grafana k6 Dashboard](https://grafana.com/grafana/dashboards/2587)
