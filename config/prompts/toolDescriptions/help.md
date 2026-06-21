Get documentation and help for Moira workflow system

Usage:

- Call without parameters for overview
- Provide 'topic' for specific documentation
- Can request multiple topics as array

Topics (dynamically discovered from documentation):

- Getting Started: introduction, quickstart
- Concepts: nodes, workflows, templates
- Patterns: patterns, pattern-skip, pattern-branching, etc.
- Integration: agent-guide, troubleshooting, claude-code, mcp-clients
- Reference: tools, validation, condition-operators, input-schema, magic-variables

Examples:

- help() - list all available topics
- help({ topic: "agent-guide" }) - MCP agent usage guide
- help({ topic: "patterns" }) - workflow pattern documentation
- help({ topic: ["pattern-skip", "pattern-branching"] }) - multiple topics
