#!/bin/bash

# ==============================================================================
# k6 Load Testing Runner with Real-Time Grafana Dashboard
# ==============================================================================
# Usage: ./scripts/run-load-testing.sh <target> <scenario> [options]
#
# Targets: local, staging, prod
# Scenarios: health, auth, workflows, executions, settings, full, stress, soak, mcp
#
# Options:
#   --vus <n>        Override VUs count
#   --duration <d>   Override duration (e.g., 30s, 5m)
#   --no-dashboard   Don't open Grafana dashboard
#   --help           Show this help
#
# Examples:
#   ./scripts/run-load-testing.sh local health
#   ./scripts/run-load-testing.sh staging stress --vus 100
#   ./scripts/run-load-testing.sh prod soak --duration 10m
# ==============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOAD_TESTS_DIR="$PROJECT_ROOT/load-tests"
K6_DIR="$LOAD_TESTS_DIR/k6"
DOCKER_COMPOSE_FILE="$LOAD_TESTS_DIR/docker-compose.k6.yml"

# Default values
GRAFANA_PORT=3033
INFLUXDB_PORT=8087
OPEN_DASHBOARD=true
CUSTOM_VUS=""
CUSTOM_DURATION=""

# ==============================================================================
# Helper Functions
# ==============================================================================

print_header() {
    echo -e "\n${BLUE}╔══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║${NC}  ${CYAN}k6 Load Testing with Real-Time Grafana Dashboard${NC}              ${BLUE}║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════╝${NC}\n"
}

print_usage() {
    echo -e "${CYAN}Usage:${NC} $0 <target> <scenario> [options]"
    echo ""
    echo -e "${CYAN}Targets:${NC}"
    echo "  local     - Local development (localhost:3032)"
    echo "  staging   - Staging environment (requires STAGING_BASE_URL)"
    echo "  prod      - Production environment (requires PROD_BASE_URL)"
    echo ""
    echo -e "${CYAN}Scenarios:${NC}"
    echo "  health     - Health endpoint validation"
    echo "  auth       - Authentication flow testing"
    echo "  workflows  - Workflow CRUD operations"
    echo "  executions - Execution management"
    echo "  settings   - User settings operations"
    echo "  full       - Mixed workload (all endpoints)"
    echo "  stress     - High-load stress test (200 VUs peak)"
    echo "  soak       - Long-running stability (30 min, 50 VUs)"
    echo "  mcp        - MCP tool patterns"
    echo "  rate-limit - Rate limiting verification (restarts Docker with rate limiting enabled)"
    echo ""
    echo -e "${CYAN}Options:${NC}"
    echo "  --vus <n>        Override VUs count"
    echo "  --duration <d>   Override duration (e.g., 30s, 5m, 1h)"
    echo "  --no-dashboard   Don't open Grafana dashboard"
    echo "  --help           Show this help"
    echo ""
    echo -e "${CYAN}Examples:${NC}"
    echo "  $0 local health"
    echo "  $0 staging stress --vus 100"
    echo "  $0 prod soak --duration 10m"
}

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "\n${CYAN}▶${NC} $1"
}

# Get scenario file from scenario name
get_scenario_file() {
    local scenario=$1
    case "$scenario" in
        health)     echo "health-check.js" ;;
        auth)       echo "auth-test.js" ;;
        workflows)  echo "api-workflows.js" ;;
        executions) echo "api-executions.js" ;;
        settings)   echo "settings-api.js" ;;
        full)       echo "full-api.js" ;;
        stress)     echo "stress.js" ;;
        soak)       echo "soak.js" ;;
        mcp)        echo "mcp-tools.js" ;;
        rate-limit) echo "rate-limit-test.js" ;;
        *)          echo "" ;;
    esac
}

# Check if scenario requires rate limiting to be enabled
requires_rate_limit() {
    local scenario=$1
    case "$scenario" in
        rate-limit) return 0 ;;  # true - requires rate limiting
        *)          return 1 ;;  # false - doesn't require
    esac
}

# ==============================================================================
# Validation Functions
# ==============================================================================

validate_target() {
    local target=$1
    
    case "$target" in
        local)
            TARGET_URL="http://host.docker.internal:3032"
            ;;
        staging)
            if [[ -z "$STAGING_BASE_URL" ]]; then
                log_error "STAGING_BASE_URL environment variable not set"
                echo "Set it in .env.local or export STAGING_BASE_URL=https://staging.example.com"
                exit 1
            fi
            TARGET_URL="$STAGING_BASE_URL"
            ;;
        prod)
            if [[ -z "$PROD_BASE_URL" ]]; then
                log_error "PROD_BASE_URL environment variable not set"
                echo "Set it in .env.local or export PROD_BASE_URL=https://example.com"
                exit 1
            fi
            TARGET_URL="$PROD_BASE_URL"
            log_warn "Running against PRODUCTION! Press Ctrl+C to abort, or wait 5 seconds..."
            sleep 5
            ;;
        *)
            log_error "Invalid target: $target"
            echo "Valid targets: local, staging, prod"
            exit 1
            ;;
    esac
    
    log_info "Target: $target → $TARGET_URL"
}

validate_scenario() {
    local scenario=$1
    
    SCENARIO_FILE=$(get_scenario_file "$scenario")
    
    if [[ -z "$SCENARIO_FILE" ]]; then
        log_error "Invalid scenario: $scenario"
        echo "Valid scenarios: health, auth, workflows, executions, settings, full, stress, soak, mcp, rate-limit"
        exit 1
    fi
    
    SCENARIO_PATH="$K6_DIR/scenarios/$SCENARIO_FILE"
    
    if [[ ! -f "$SCENARIO_PATH" ]]; then
        log_error "Scenario file not found: $SCENARIO_PATH"
        exit 1
    fi
    
    log_info "Scenario: $scenario → $SCENARIO_FILE"
}

# ==============================================================================
# Docker Management
# ==============================================================================

# Restart local Docker container with rate limiting enabled
restart_docker_with_rate_limit() {
    log_step "Restarting local Docker container with rate limiting ENABLED..."

    local docker_script="$SCRIPT_DIR/docker-build-and-run.sh"

    if [[ ! -f "$docker_script" ]]; then
        log_error "Docker build script not found: $docker_script"
        exit 1
    fi

    log_info "Running: $docker_script --rate-limit"
    cd "$PROJECT_ROOT"

    # Run the docker build script with rate limiting enabled
    if ! "$docker_script" --rate-limit; then
        log_error "Failed to restart Docker container with rate limiting"
        exit 1
    fi

    log_info "Docker container restarted with rate limiting enabled"

    # Brief pause to ensure container is fully ready
    sleep 2
}

check_docker() {
    if ! command -v docker &> /dev/null; then
        log_error "Docker not found. Please install Docker."
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        log_error "Docker daemon not running. Please start Docker."
        exit 1
    fi
}

start_metrics_stack() {
    log_step "Starting metrics stack (InfluxDB + Grafana)..."
    
    cd "$LOAD_TESTS_DIR"
    
    # Check if stack is already running
    if docker compose -f docker-compose.k6.yml ps --quiet influxdb 2>/dev/null | grep -q .; then
        log_info "Metrics stack already running"
    else
        log_info "Starting InfluxDB and Grafana..."
        docker compose -f docker-compose.k6.yml up -d influxdb grafana
        
        # Wait for services to be ready
        log_info "Waiting for services to be ready..."
        sleep 5
        
        # Check InfluxDB health
        local retries=0
        while ! curl -sf "http://localhost:$INFLUXDB_PORT/health" &>/dev/null; do
            retries=$((retries + 1))
            if [[ $retries -ge 30 ]]; then
                log_error "InfluxDB failed to start"
                exit 1
            fi
            sleep 1
        done
        log_info "InfluxDB ready"
        
        # Check Grafana health
        retries=0
        while ! curl -sf "http://localhost:$GRAFANA_PORT/api/health" &>/dev/null; do
            retries=$((retries + 1))
            if [[ $retries -ge 30 ]]; then
                log_error "Grafana failed to start"
                exit 1
            fi
            sleep 1
        done
        log_info "Grafana ready"
    fi
    
    cd "$PROJECT_ROOT"
}

open_dashboard() {
    if [[ "$OPEN_DASHBOARD" == "true" ]]; then
        log_step "Opening Grafana dashboard..."
        
        local dashboard_url="http://localhost:$GRAFANA_PORT/d/moira-k6-load-testing/moira-k6-load-testing?orgId=1&refresh=5s"
        
        # Detect OS and open browser
        case "$(uname -s)" in
            Darwin)
                open "$dashboard_url" 2>/dev/null || true
                ;;
            Linux)
                xdg-open "$dashboard_url" 2>/dev/null || sensible-browser "$dashboard_url" 2>/dev/null || true
                ;;
            *)
                log_warn "Cannot auto-open browser. Please open: $dashboard_url"
                ;;
        esac
        
        log_info "Dashboard: $dashboard_url"
    fi
}

# ==============================================================================
# Test Execution
# ==============================================================================

run_k6_test() {
    log_step "Running k6 load test..."
    
    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}  Target:${NC}   $TARGET"
    echo -e "${CYAN}  URL:${NC}      $TARGET_URL"
    echo -e "${CYAN}  Scenario:${NC} $SCENARIO ($SCENARIO_FILE)"
    [[ -n "$CUSTOM_VUS" ]] && echo -e "${CYAN}  VUs:${NC}      $CUSTOM_VUS"
    [[ -n "$CUSTOM_DURATION" ]] && echo -e "${CYAN}  Duration:${NC} $CUSTOM_DURATION"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
    
    # Build k6 command arguments
    # Note: k6 container connects to influxdb via Docker network, not localhost
    local k6_args="run --out influxdb=http://influxdb:8086/k6"
    
    # Add custom VUs if specified
    if [[ -n "$CUSTOM_VUS" ]]; then
        k6_args="$k6_args --vus $CUSTOM_VUS"
    fi
    
    # Add custom duration if specified
    if [[ -n "$CUSTOM_DURATION" ]]; then
        k6_args="$k6_args --duration $CUSTOM_DURATION"
    fi
    
    # Add scenario file
    k6_args="$k6_args /scripts/scenarios/$SCENARIO_FILE"
    
    # Load env vars from .env.local if exists
    if [[ -f "$PROJECT_ROOT/.env.local" ]]; then
        eval "$(grep -v '^#' "$PROJECT_ROOT/.env.local" | grep -E '^(LOAD_TEST_SECRET|STAGING_BASE_URL|PROD_BASE_URL)=' | sed 's/^/export /')" 2>/dev/null || true
    fi
    
    # Run k6 via Docker
    cd "$LOAD_TESTS_DIR"

    # For rate-limit scenario, disable the bypass header so we can test rate limiting
    local disable_bypass=""
    if requires_rate_limit "$SCENARIO"; then
        disable_bypass="-e DISABLE_RATE_BYPASS=true"
        log_info "Rate limit bypass DISABLED for this scenario (testing rate limits)"
    fi

    docker compose -f docker-compose.k6.yml run --rm \
        -e TARGET_ENV="$TARGET" \
        -e TARGET_BASE_URL="$TARGET_URL" \
        -e LOAD_TEST_SECRET="${LOAD_TEST_SECRET:-}" \
        $disable_bypass \
        k6 $k6_args

    local exit_code=$?

    cd "$PROJECT_ROOT"

    return $exit_code
}

# ==============================================================================
# Cleanup Handler
# ==============================================================================

cleanup() {
    echo ""
    log_warn "Test interrupted. Cleaning up..."
    
    # Stop any running k6 container
    cd "$LOAD_TESTS_DIR"
    docker compose -f docker-compose.k6.yml stop k6 2>/dev/null || true
    cd "$PROJECT_ROOT"
    
    log_info "Metrics stack left running. Stop with: docker compose -f load-tests/docker-compose.k6.yml down"
    exit 130
}

# ==============================================================================
# Main
# ==============================================================================

main() {
    # Set up signal handlers
    trap cleanup SIGINT SIGTERM
    
    print_header
    
    # Parse arguments
    if [[ $# -lt 1 ]]; then
        print_usage
        exit 1
    fi
    
    # Handle help flag anywhere
    for arg in "$@"; do
        if [[ "$arg" == "--help" || "$arg" == "-h" ]]; then
            print_usage
            exit 0
        fi
    done
    
    if [[ $# -lt 2 ]]; then
        print_usage
        exit 1
    fi
    
    TARGET="$1"
    SCENARIO="$2"
    shift 2
    
    # Parse options
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --vus)
                CUSTOM_VUS="$2"
                shift 2
                ;;
            --duration)
                CUSTOM_DURATION="$2"
                shift 2
                ;;
            --no-dashboard)
                OPEN_DASHBOARD=false
                shift
                ;;
            *)
                log_error "Unknown option: $1"
                print_usage
                exit 1
                ;;
        esac
    done
    
    # Load environment variables
    if [[ -f "$PROJECT_ROOT/.env.local" ]]; then
        eval "$(grep -v '^#' "$PROJECT_ROOT/.env.local" | grep -E '^(STAGING_BASE_URL|PROD_BASE_URL|LOAD_TEST_SECRET)=' | sed 's/^/export /')" 2>/dev/null || true
    fi
    
    # Validate inputs
    validate_target "$TARGET"
    validate_scenario "$SCENARIO"
    
    # Check Docker
    check_docker

    # For rate-limit scenario against local, restart Docker with rate limiting enabled
    if requires_rate_limit "$SCENARIO" && [[ "$TARGET" == "local" ]]; then
        log_warn "Rate limit scenario requires rate limiting to be ENABLED on the server"
        restart_docker_with_rate_limit
    fi

    # Start metrics stack
    start_metrics_stack
    
    # Open dashboard
    open_dashboard
    
    # Wait a moment for dashboard to open
    sleep 2
    
    # Run test
    log_step "Starting load test..."
    if run_k6_test; then
        echo ""
        log_info "Load test completed successfully!"
        log_info "View results in Grafana: http://localhost:$GRAFANA_PORT"
    else
        echo ""
        log_error "Load test failed or threshold exceeded"
        exit 1
    fi
}

# Run main function
main "$@"
