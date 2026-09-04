Get documentation and help for Moira workflow system

Usage:

- Call without parameters to list the current topic names and accepted aliases
- Provide 'topic' for specific documentation
- Can request multiple topics as array

Topics are discovered from the installed documentation. Call without `topic` to obtain the current
topic names and accepted aliases instead of relying on a fixed list.

Examples:

- help() - list all available topics
- help({ topic: "agent-guide" }) - MCP agent usage guide
- help({ topic: "tools" }) - factual reference generated from the typed MCP registry
- help({ topic: ["overview", "tools"] }) - multiple topics
