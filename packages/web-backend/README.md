# MCP Moira Backend API Server

Express.js API server for MCP Moira workflow visualization system.

## 🚀 Quick Start

All development happens through Docker containers.

```bash
# From project root
npm run docker:restart  # Build and run Docker
```

## 📡 API Endpoints

### Health & Configuration

- `GET /api/health` - System health check
- `GET /api/config` - Server configuration
- `GET /api/status` - Detailed system status

### Workflow Management

- `GET /api/workflows` - List all workflows grouped by folder
- `GET /api/workflows/:folder` - Get workflows from specific folder
- `GET /api/workflows/:folder/:id` - Get specific workflow for visualization
- `GET /api/workflows/:folder/:id/raw` - Get raw workflow JSON
- `POST /api/workflows/:folder/:id/validate` - Validate workflow

### Folder Management

- `GET /api/folders` - Get available workflow folders

## 🔧 Configuration

### Environment Variables

```bash
# Server
NODE_ENV=development
WEB_BACKEND_PORT=4201
BACKEND_HOST=localhost

# Workflow directories
WORKFLOW_DIRS=workflows/production,workflows/tests
```

### Default Configuration

- **Port:** 4201 (internal, accessed via nginx proxy on DOCKER_PORT)
- **Workflow Directories:** `workflows/production`, `workflows/tests`
- **CORS:** Configured dynamically via `getBaseUrl()` + `EXTRA_TRUSTED_ORIGINS` env var
- **Caching:** Disabled (always reads fresh from disk)
- **File Watching:** Disabled (manual updates only)

## 🏗️ Architecture

### Directory Structure

```
backend/src/
├── routes/              # API route handlers
│   ├── health.ts       # Health and configuration endpoints
│   └── workflows.ts    # Workflow management endpoints
├── services/           # Business logic services
│   ├── file-service.ts # No-cache file operations
│   └── validation-service.ts # MCP validation integration
├── middleware/         # Express middleware
│   ├── cors-middleware.ts # CORS configuration
│   └── error-middleware.ts # Error handling
├── utils/              # Utility functions
└── server.ts           # Main server application
```

### Integration Strategy

- **No Existing Code Changes:** Import-only approach with MCP engine
- **Shared Types:** Uses `@shared` package for type safety
- **MCP Validation:** Integrates existing validation system
- **Fresh Data:** No caching, always reads from disk

## 🔒 Security & Authentication

### Authentication

- **Better Auth:** OAuth 2.1 authentication framework
- **Session Middleware:** requireAuth protects all /api/_ routes (except /api/auth/_)
- **Better Auth Routes:** /api/auth/\* handled by toNodeHandler(auth)
- **OAuth Endpoints:** /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server

### Protected Routes

All API routes require authentication:

```typescript
// Middleware automatically adds userId to req.userId
app.use("/api/health", requireAuth, healthRoutes);
app.use("/api/workflows", requireAuth, workflowRoutes);
```

### CORS

- **Development:** origin: true, allowedHeaders: '\*' (MCP Inspector cross-origin)
- **Production:** CORS whitelist based on MOIRA_HOST environment variable
- **Production:** Strict origin whitelisting
- **Credentials:** enabled for cookie-based sessions

### Security Headers

- **Helmet.js:** CSP, XSS protection, HSTS
- **Input Validation:** Path traversal and injection prevention
- **Error Handling:** No sensitive data in error responses

## 🧪 Testing

```bash
# Health check
curl http://localhost:${DOCKER_PORT}/api/health

# Get workflows
curl http://localhost:${DOCKER_PORT}/api/workflows

# Get specific workflow
curl http://localhost:${DOCKER_PORT}/api/workflows/production/example-conditional
```

## 📊 Monitoring

### Health Check Response

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "services": {
      "fileSystem": true,
      "validation": true,
      "mcpEngine": true
    },
    "uptime": 3600,
    "timestamp": "2025-09-03T02:00:00.000Z",
    "version": "0.1.0"
  }
}
```

### Error Response Format

```json
{
  "success": false,
  "error": {
    "code": "WORKFLOW_NOT_FOUND",
    "message": "Workflow not found: example in folder production",
    "timestamp": "2025-09-03T02:00:00.000Z"
  }
}
```

## 🔄 Development Workflow

All development happens through Docker containers:

```bash
# From project root
npm run docker:restart  # Build and run all services
# Access: http://localhost:${DOCKER_PORT}
```

## 🚀 Production Deployment

```bash
# Deploy to production (${MOIRA_HOST})
npm run deploy:prod

# Deploy to staging
npm run deploy:staging
```

## 📋 API Documentation

Full API documentation available at: `http://localhost:${DOCKER_PORT}/api`

## 🔗 Integration

### With Frontend

```typescript
// Frontend API client usage
import { ApiClient } from "@shared";

const client = new ApiClient("http://localhost:${DOCKER_PORT}");
const workflows = await client.getWorkflows();
```

### With MCP Engine

```typescript
// Backend MCP integration
import { GraphValidator } from "@mcp-core/graph/validation/graph-validator.js";
import { WorkflowGraph } from "@shared";

const validator = new GraphValidator();
const result = await validator.validate(workflow);
```
