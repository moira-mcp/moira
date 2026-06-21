# Agent Onboarding Guide

## MCP Moira System Overview

**System Type**: Agent Workflow Engine  
**Primary Purpose**: Execute AI agent workflows as directed graphs
**Key Technologies**: TypeScript, Node.js, React, Express, MCP Protocol

## Study Sequence

### Phase 1: Architecture Understanding

```bash
# 1. Read core documentation
README.md                    # System overview
docs/SYSTEM.md              # Technical reference
PROJECT-STRUCTURE.md        # File organization

# 2. Study core interfaces
packages/workflow-engine/src/interfaces/core-interfaces.ts  # Main contracts
packages/workflow-engine/src/types/graph-nodes.ts          # Node type definitions
```

### Phase 2: Component Analysis

```bash
# 3. Understand execution engine
packages/workflow-engine/src/core/universal-graph-executor.ts  # Main workflow processor
packages/workflow-engine/src/handlers/                     # Node type processors

# 4. Study storage and validation
packages/workflow-engine/src/storage/graph-file-storage.ts     # Persistence layer
packages/workflow-engine/src/validation/graph-validator.ts     # Validation rules
```

### Phase 3: Practical Verification

**Quick Development Testing:**

```bash
# 5. Run test suite
npm install && npm test

# 6. Start Docker development environment
npm run docker:restart  # Build and run all services in Docker

# 7. Check web interface
# Open http://localhost:${DOCKER_PORT}
# Verify workflow list loads
# Test workflow visualization
# Click nodes to test detail view
```

**Integration Testing (MCP Functionality Validation):**

```bash
# 8. Start Docker integration environment
npm run docker:restart  # Build → Start → Wait for ready
# Script waits up to 30 seconds for complete application startup
# Access: http://localhost:${DOCKER_PORT}

# 9. Verify MCP functionality via moira-local MCP server
# MCP servers: moira = production (${MOIRA_HOST}), moira-stage = staging, moira-local = Docker (localhost:${DOCKER_PORT})
/mcp list                                               # Test MCP tools
/mcp start bug-hunting-workflow                         # Test workflow execution
/mcp manage {"action":"get","workflowId":"software-development-flow"}  # Test workflow inspection
/mcp step <process-id> {"input": "test"}                # Test step execution

# 10. Validate all endpoints
curl http://localhost:${DOCKER_PORT}/health            # MCP Server health
curl http://localhost:${DOCKER_PORT}/api/health        # Backend API health
# Open http://localhost:${DOCKER_PORT} in browser      # Frontend UI
```

## Critical Understanding Points

### Node Types and Behavior

- **start** - Auto-executes, merges data, continues
- **agent-directive** - Pauses for user input, validates response
- **condition** - Auto-executes, branches on true/false
- **expression** - Auto-executes, computes values using arithmetic
- **telegram-notification** - Auto-executes, sends message, continues
- **teleport** - Jump target only reachable via explicit teleport, behaves like agent-directive
- **subgraph** - Delegates to another workflow, maps input/output context
- **end** - Auto-executes, collects final data, completes

Automatic node types (execute without agent interaction):

- **read-note** / **write-note** / **upsert-note** - Persistent note storage operations

### Template System

- Variables: `{{variable}}`, `{{nested.path}}`, `{{array[0]}}`
- System vars: `{{executionId}}`, `{{workflowId}}`
- Processing locations: directive, completionCondition, message fields

### Storage Architecture

- Executions: `.graph-storage/executions/<uuid>.json`
- Workflows: `workflows/production/<name>.json`
- No caching - fresh reads on each operation

### Web UI Architecture

- All services accessed via single Docker port (DOCKER_PORT from `.env.local`)
- nginx proxies `/api/*` to backend, `/mcp` to MCP server, `/` serves static frontend
- NEVER call internal ports directly — always use DOCKER_PORT

## Verification Checklist

### ✅ System Understanding

- [ ] Can explain node-graph execution model
- [ ] Understands difference between auto-executing nodes vs pause nodes
- [ ] Knows where workflows are stored and how they're loaded
- [ ] Understands template variable processing

### ✅ Practical Operation

- [ ] Successfully started MCP server
- [ ] Web UI loads and displays workflows
- [ ] Can execute workflow via MCP tools
- [ ] Tests pass and understand what they verify

### ✅ Development Setup

- [ ] Knows how to start Docker development environment
- [ ] Understands nginx proxy setup in Docker
- [ ] Can create and test new workflow files
- [ ] Knows testing requirements (Playwright for web UI changes)

## Common Agent Mistakes to Avoid

### Web UI Development

- **WRONG**: Call backend port directly from frontend
- **RIGHT**: Use `/api/` paths (nginx proxy handles routing in Docker)

### Workflow Development

- **WRONG**: Reference non-existent node IDs in connections
- **RIGHT**: Verify all connection targets exist in nodes array

### Documentation Updates

- **WRONG**: Add historical info ("was improved", "replaced previous")
- **RIGHT**: Only current technical facts from code

### Testing

- **WRONG**: Assume code works without running tests
- **RIGHT**: Always run tests and verify functionality

## Architecture-Specific Knowledge

### MCP Protocol Integration

- MCP tools: list, start, step, manage, help, settings, session, token
- Spawn-based architecture for hot reload of workflow files
- System reminder integration in all responses

### Graph Engine Specifics

- Message queue system for agent communication
- Context management with variable persistence
- JSON Schema validation for all inputs
- Template processing with safe serialization

### File Organization Logic

- `packages/workflow-engine/` - Core engine (handlers, storage, types)
- `packages/web-backend/` + `packages/web-frontend/` - Web UI components
- `workflows/production/` - Working examples
- `tests/` - Unit and integration test suites

**Goal**: After following this guide, agent should understand MCP Moira well enough to implement features correctly and maintain system architecture.
