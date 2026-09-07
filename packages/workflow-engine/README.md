# @mcp-moira/workflow-engine

Core node-graph execution engine for MCP Moira Agent Workflow Engine.

## Features

- **Node handlers**: built-in graph execution including channel-neutral user notifications, deprecated Telegram compatibility, notes, locks, materialization, subgraphs, expressions, conditions, and agent tasks
- **Storage**: File-based and in-memory workflow storage
- **Validation**: JSON Schema validation with AJV
- **Templates**: Variable interpolation and template processing
- **Execution**: Universal graph executor with state management

## API

```typescript
import {
  UniversalGraphExecutor,
  GraphFileStorage,
  StartNodeHandler,
  EndNodeHandler,
  AgentDirectiveHandler,
  ConditionHandler,
  UserNotificationHandler,
  TelegramNotificationHandler,
} from "@mcp-moira/workflow-engine";
```

## Usage

```typescript
const storage = new GraphFileStorage();
const executor = new UniversalGraphExecutor(storage);

executor.registerNodeHandler("start", new StartNodeHandler());
executor.registerNodeHandler("end", new EndNodeHandler());
// ... register other handlers

const executionId = await executor.startWorkflow(workflow);
const result = await executor.executeStep(executionId, input);
```
