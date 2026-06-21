# Performance Baselines and SLAs

This document defines performance baselines and Service Level Agreements (SLAs) for MCP Moira.

## Table of Contents

- [Overview](#overview)
- [SLA Definitions](#sla-definitions)
- [Performance Targets](#performance-targets)
- [Baseline Results](#baseline-results)
- [Threshold Configuration](#threshold-configuration)
- [CI/CD Integration](#cicd-integration)

## Overview

Performance baselines are established using k6 load tests with InfluxDB metrics and Grafana dashboards. These baselines define acceptable response times and error rates for production deployments.

### Test Environment

- **Server**: Docker container (mcp-moira-dev)
- **CPU**: Host machine resources (limit as configured)
- **Memory**: Host machine resources
- **Database**: PostgreSQL (in container)
- **Load Generator**: k6 with InfluxDB + Grafana

## SLA Definitions

### Response Time SLAs

| Tier         | p50 (median) | p95     | p99     | p100 (max) |
| ------------ | ------------ | ------- | ------- | ---------- |
| **Critical** | ≤ 50ms       | ≤ 100ms | ≤ 200ms | ≤ 1s       |
| **Standard** | ≤ 100ms      | ≤ 250ms | ≤ 500ms | ≤ 2s       |
| **Relaxed**  | ≤ 200ms      | ≤ 500ms | ≤ 1s    | ≤ 5s       |

### Endpoint Tier Classification

| Endpoint             | Tier     | Rationale                  |
| -------------------- | -------- | -------------------------- |
| GET /api/health      | Critical | Health checks must be fast |
| GET /api/user/me     | Critical | Session validation         |
| GET /api/workflows   | Standard | List operations            |
| GET /api/executions  | Standard | List operations            |
| POST /api/mcp/\*     | Standard | MCP tool calls             |
| GET /api/settings/\* | Relaxed  | Admin operations           |
| GET /api/admin/\*    | Relaxed  | Admin operations           |

### Error Rate SLAs

| Metric                    | Target | Maximum |
| ------------------------- | ------ | ------- |
| **HTTP 5xx**              | 0%     | ≤ 0.1%  |
| **HTTP 4xx** (unexpected) | 0%     | ≤ 1%    |
| **Network Errors**        | 0%     | ≤ 0.01% |
| **Timeout Rate**          | 0%     | ≤ 0.5%  |

### Throughput SLAs

| Profile    | Sustained RPS | Peak RPS | Duration |
| ---------- | ------------- | -------- | -------- |
| **Light**  | 10 RPS        | 15 RPS   | 5 min    |
| **Medium** | 50 RPS        | 75 RPS   | 15 min   |
| **Heavy**  | 150 RPS       | 200 RPS  | 25 min   |
| **Soak**   | 50 RPS        | 50 RPS   | 30 min   |

## Performance Targets

### Health Check Endpoint

**Scenario**: `k6/scenarios/health-check.js`

| Metric       | Target |
| ------------ | ------ |
| p50          | ≤ 10ms |
| p95          | ≤ 20ms |
| p99          | ≤ 50ms |
| Success Rate | 100%   |

### Workflows API

**Scenario**: `k6/scenarios/api-workflows.js`

| Metric       | Target  |
| ------------ | ------- |
| p50          | ≤ 50ms  |
| p95          | ≤ 150ms |
| p99          | ≤ 300ms |
| Success Rate | ≥ 99.9% |

### Executions API

**Scenario**: `k6/scenarios/api-executions.js`

| Metric       | Target  |
| ------------ | ------- |
| p50          | ≤ 75ms  |
| p95          | ≤ 200ms |
| p99          | ≤ 400ms |
| Success Rate | ≥ 99.9% |

### MCP Tools

**Scenario**: `k6/scenarios/mcp-tools.js`

| Metric       | Target  |
| ------------ | ------- |
| p50          | ≤ 100ms |
| p95          | ≤ 300ms |
| p99          | ≤ 500ms |
| Success Rate | ≥ 99.5% |

### Full System (All Endpoints)

**Scenario**: `k6/scenarios/full-api.js`

| Metric        | Target  |
| ------------- | ------- |
| p50           | ≤ 100ms |
| p95           | ≤ 300ms |
| p99           | ≤ 600ms |
| Success Rate  | ≥ 99%   |
| Sustained RPS | 150     |

## Baseline Results

> **Note**: Update this section after running baseline tests.

### Initial Baseline (Date: TBD)

Run all baseline tests and record results:

```bash
./scripts/run-load-testing.sh local health
./scripts/run-load-testing.sh local workflows
./scripts/run-load-testing.sh local executions
./scripts/run-load-testing.sh local mcp
./scripts/run-load-testing.sh local full
```

#### Results Template

| Test                  | p50 | p95 | p99 | p100 | Success % | RPS | Status  |
| --------------------- | --- | --- | --- | ---- | --------- | --- | ------- |
| health-check-light    | -   | -   | -   | -    | -         | -   | Pending |
| api-workflows-medium  | -   | -   | -   | -    | -         | -   | Pending |
| api-executions-medium | -   | -   | -   | -    | -         | -   | Pending |
| mcp-mixed-medium      | -   | -   | -   | -    | -         | -   | Pending |
| full-api-medium       | -   | -   | -   | -    | -         | -   | Pending |

### Stress Test Results (Date: TBD)

Run stress tests to determine system limits:

```bash
./scripts/run-load-testing.sh local stress
./scripts/run-load-testing.sh local soak
```

## Threshold Configuration

### k6 Thresholds

k6 scenarios include built-in thresholds that fail the test if SLAs are violated:

```javascript
export const options = {
  thresholds: {
    // Stop if p95 > 500ms
    http_req_duration: ["p(95)<500"],
    // Stop if more than 1% errors
    http_req_failed: ["rate<0.01"],
    // Check-specific thresholds
    checks: ["rate>0.99"],
  },
};
```

### Threshold Library

The `k6/lib/thresholds.js` module provides SLA thresholds for each endpoint type:

```typescript
const THRESHOLDS = {
  p50: 100, // ms
  p95: 300, // ms
  p99: 600, // ms
  p100: 2000, // ms (max)
  errorRate: 1, // percent
  successRate: 99, // percent
};
```

## CI/CD Integration

### GitHub Actions (Example)

```yaml
- name: Start Metrics Stack
  run: |
    cd load-tests
    docker compose -f docker-compose.k6.yml up -d influxdb grafana

- name: Run Load Tests
  run: |
    ./scripts/run-load-testing.sh local health --no-dashboard
    ./scripts/run-load-testing.sh local workflows --no-dashboard

- name: Check SLA Compliance
  run: |
    # k6 exits non-zero if thresholds fail
    echo "Tests passed - all SLA thresholds met"
```

### Pre-Deployment Gate

Before deploying to production:

1. Run `./scripts/run-load-testing.sh local workflows`
2. Run `./scripts/run-load-testing.sh local full`
3. Verify all k6 thresholds pass
4. Check Grafana dashboard for anomalies

## Regression Detection

### Acceptable Variance

| Metric     | Warning Threshold | Failure Threshold |
| ---------- | ----------------- | ----------------- |
| p50        | +10%              | +25%              |
| p95        | +15%              | +30%              |
| p99        | +20%              | +50%              |
| Error Rate | +0.5%             | +1%               |

### Comparison with Grafana

Use Grafana dashboard to compare performance over time:

1. Open http://localhost:3033
2. Select time range covering multiple test runs
3. Compare p50, p95, p99 trends
4. Check error rate patterns

k6 threshold violations appear in test output:

```
✓ http_req_duration..............: avg=45ms   min=5ms   med=42ms   max=520ms   p(95)=165ms
✗ http_req_failed................: 1.2%   ✓ 12 ✗ 988
```

## Maintenance

### Updating Baselines

Re-establish baselines when:

1. Major code changes (new features, refactoring)
2. Infrastructure changes (new server, DB upgrade)
3. Quarterly review (minimum)

### Baseline Update Process

1. Run full test suite on clean environment
2. Review results for anomalies
3. Update baseline values in this document
4. Commit changes with date and reason
5. Notify team of new baseline

## References

- [k6 Documentation](https://k6.io/docs/)
- [k6 Thresholds](https://k6.io/docs/using-k6/thresholds/)
- [k6 Scenarios](https://k6.io/docs/using-k6/scenarios/)
- [InfluxDB Integration](https://k6.io/docs/results-output/real-time/influxdb/)
- [Response Time Percentiles](https://www.dynatrace.com/news/blog/why-averages-suck-and-percentiles-are-great/)
