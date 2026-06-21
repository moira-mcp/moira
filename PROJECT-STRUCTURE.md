# Project Structure

```
mcp-moira/
├── packages/                         # Monorepo packages
│   ├── workflow-engine/              # Core workflow execution engine
│   │   ├── src/                      # Engine source code
│   │   │   ├── core/                 # Core execution components
│   │   │   ├── handlers/             # Node type handlers
│   │   │   ├── storage/              # File persistence
│   │   │   ├── types/                # TypeScript definitions
│   │   │   ├── validation/           # JSON Schema validation
│   │   │   └── index.ts              # Public API exports
│   │   └── tests/                    # Engine tests
│   ├── mcp-server/                   # MCP HTTP protocol server
│   │   ├── src/                      # Server source code
│   │   │   ├── server.ts             # HTTP transport
│   │   │   ├── tools/                # MCP protocol tools
│   │   │   ├── cli/                  # CLI commands
│   │   │   └── core/                 # MCP engine adapter
│   │   └── tests/                    # MCP tests
│   ├── web-backend/                  # Express Web API
│   │   ├── src/                      # Backend source code
│   │   │   ├── routes/               # API endpoints
│   │   │   ├── services/             # Business logic
│   │   │   ├── middleware/           # Express middleware
│   │   │   └── types/                # Backend types
│   │   └── tests/                    # Backend tests
│   ├── shared/                        # Shared library (@mcp-moira/shared)
│   │   └── src/                      # Config, types, services, MCP client data
│   └── web-frontend/                 # React Web UI
│       ├── src/                      # Frontend source code
│       │   ├── components/           # React components
│       │   │   ├── cards/            # Reusable card components (list + grid modes)
│       │   │   ├── workflow/         # Workflow-specific components
│       │   ├── services/             # API clients
│       │   ├── types/                # Frontend types
│       │   └── App.tsx               # Main app
│       └── tests/                    # Frontend tests
├── tests/                            # Cross-package integration tests
├── workflows/production/             # Workflow definitions
├── docs/                             # Documentation
├── package.json                      # Workspace configuration
├── tsconfig.base.json                # Base TypeScript config
└── README.md                         # Main project documentation
```

## Development Commands

```bash
npm install             # Install dependencies
npm run docker:restart  # Build and run Docker
npm test                # Run all tests
npm run fix             # ESLint + Prettier fix
```

## Package Architecture

### workflow-engine

Core workflow execution logic with node handlers, storage, and validation.

### mcp-server

MCP HTTP protocol implementation with tools and CLI commands.

### web-backend

Express API server for workflow visualization and management.

### web-frontend

React UI for workflow visualization using Ant Design and React Flow.
