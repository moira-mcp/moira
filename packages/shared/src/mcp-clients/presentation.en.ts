export default {
  common: {
    serverUrl: "Server URL",
    officialDocs: "Official client documentation",
    alternativeTitle: "Manual configuration",
    fallbackAuth:
      "Follow the official client documentation to authorize this server. An existing working connection does not need another login.",
    verificationSuffix:
      "Then ask the agent to call Moira's read-only list tool and show the available workflows. A saved configuration alone does not prove a working connection.",
  },
  tabs: {
    "claude-code": {
      setup:
        "Run the command in your project. Its default scope is local to you in that project; add --scope user for all projects. The manual .mcp.json alternative below is project scope; review trust before enabling it. Merge entries into an existing file rather than replacing other servers.",
      authIntro:
        "When authorization is needed, follow the browser prompt or run the login command. For a remote terminal, claude mcp login moira --no-browser prints a link. Do not repeat login for an already working connection.",
      authContent: "claude mcp login moira",
      verification:
        "Run claude mcp list or open /mcp in Claude Code and check Moira's connection and tools.",
    },
    "copilot-cli": {
      setup:
        'Run the command to add the HTTP server. User configuration is ~/.copilot/mcp-config.json. Portable project files are .mcp.json or .github/mcp.json; they use mcpServers, not VS Code\'s servers format. The manual example enables all server tools with tools: ["*"]; narrow that list if required. Organization policy may restrict servers or tools.',
      authIntro:
        "In a Copilot CLI session, run the authentication command when needed and complete browser authorization.",
      authContent: "/mcp auth moira",
      verification:
        "Use /mcp show moira to inspect status and tools, or copilot mcp list from the terminal.",
    },
    cursor: {
      setup:
        "Use the install button and review Cursor's prompt, or merge the manual entry into ~/.cursor/mcp.json for your user or .cursor/mcp.json for this project. Restart Cursor after manual configuration. Local editor setup does not automatically configure Cloud Agents.",
      authIntro:
        "Open Customize → MCPs and complete the HTTP server's authentication prompt when needed. The token configuration below is an alternative to browser OAuth.",
      verification:
        "Check Moira in Customize → MCPs and the chat's tool list. If it is missing, inspect Output → MCP Logs.",
      deeplinkButton: "Add to Cursor",
      ariaLabel: "Install the Moira MCP server in Cursor",
    },
    "claude-desktop": {
      setup:
        "Open Customize → Connectors → + Add → Add custom connector. Enter Moira and the Server URL below, then Continue, review authentication and Add. This is an account-hosted remote connector shared with Claude Web. Its HTTPS endpoint must be reachable from Claude's cloud. Organization owners may need to add it before members connect; Free supports one custom connector.",
      authIntro:
        "Choose sign-in and complete browser OAuth when requested. An organization member may first need to connect the connector provided by an owner.",
      verification: "In a conversation, open + → Connectors and enable Moira.",
    },
    vscode: {
      setup:
        "Use the install button and review the prompt, or merge the manual servers entry into .vscode/mcp.json. For user scope, use VS Code's user MCP configuration command. These examples configure VS Code's native integration, not a separate terminal agent's configuration.",
      authIntro:
        "Review the workspace/server trust prompt and complete browser sign-in when requested. The token configuration below is a separate authentication alternative.",
      verification:
        "Run MCP: List Servers, select Moira, then Start Server or Show Output. Check tool discovery and that the selected agent harness enables this server.",
      deeplinkButton: "Add to VS Code",
      ariaLabel: "Install the Moira MCP server in VS Code",
    },
    "claude-web": {
      setup:
        "On claude.ai, open Customize → Connectors → + Add → Add custom connector. Enter Moira and the Server URL below, then Continue, review authentication and Add. The HTTPS endpoint must be reachable from Claude's cloud. Free supports one custom connector; organization policies and owner setup may also apply.",
      authIntro:
        "Choose sign-in and complete browser OAuth when requested. Organization members connect the connector an owner has made available.",
      verification: "In a conversation, open + → Connectors and enable Moira.",
    },
    chatgpt: {
      setup:
        "Open https://chatgpt.com/plugins. Use plus → Add custom MCP server, enter a name and the Server URL below, select authentication, review the warning and Create as a plugin. Install the resulting plugin separately. The HTTPS endpoint must be reachable from ChatGPT's cloud; workspace permissions and security policies may restrict custom servers.",
      authIntro: "Select OAuth for authenticated Moira and complete authorization when requested.",
      verification:
        "Select the installed Moira plugin with @ in a conversation and explicitly request its tool.",
      deeplinkButton: "Open ChatGPT plugins",
      ariaLabel: "Open ChatGPT plugins to add a custom MCP server",
    },
    perplexity: {
      setup:
        "Open Plugins, or Customize → Connectors during the interface rollout. Choose Add custom → Connector → Add MCP connector → Remote, enter the HTTPS Server URL below, choose Streamable HTTP and Add. Remote connectors are available on supported Pro, Max and Enterprise plans; enterprise permissions may also apply. This remote path needs no Mac helper.",
      authIntro:
        "Choose OAuth, then open the resulting connector card to authenticate and enable it. The endpoint must be reachable from Perplexity's cloud.",
      verification:
        "Check that the connector is enabled and available to the current conversation.",
    },
    continue: {
      setup:
        "Merge this fragment into your active Continue YAML configuration, commonly ~/.continue/config.yaml. Keep existing configuration and server entries. A standalone .continue/mcpServers/moira.yaml block additionally needs name, version and schema metadata; this is an active-config fragment, not a complete standalone block.",
      authIntro:
        "Use the documented token path: sign in to Moira → Settings → API Tokens, create a token and replace moira_YOUR_TOKEN in the configuration. Authorization belongs under requestOptions.headers. Do not assume that an arbitrary remote server supports browser OAuth in Continue.",
      verification:
        "Switch to Agent mode and confirm that the agent can use the configured Moira tools.",
    },
    zed: {
      setup:
        "Open Settings → AI → MCP Servers → Add Server → Add Remote Server and enter the configured endpoint, or merge the context_servers entry below into ~/.config/zed/settings.json. Preserve other settings and servers.",
      authIntro:
        "With no Authorization header, follow Zed's MCP OAuth prompt when needed. A static Authorization header is the token alternative below.",
      verification:
        "Look for the green dot and Server is active tooltip, then use Zed Agent. Terminal agents use their own native CLI configuration; another agent harness may have separate server forwarding.",
    },
    "gemini-cli": {
      setup:
        "Run the command in your project; add --scope user for all projects. The manual alternative can be merged into .gemini/settings.json or ~/.gemini/settings.json. Use httpUrl for Streamable HTTP: Gemini's url field selects legacy SSE.",
      authIntro:
        "In a Gemini CLI session, run the authentication command when needed and complete browser OAuth. Use the token alternative when a browser callback is unsuitable.",
      authContent: "/mcp auth moira",
      verification:
        "Run gemini mcp list from the terminal or /mcp list in the session to inspect connection status and errors.",
    },
    codex: {
      setup:
        "Run the command to register the HTTP server, or merge the TOML alternative into ~/.codex/config.toml. A trusted project's .codex/config.toml provides project scope. Configuration is shared by local Codex CLI, desktop and IDE surfaces; do not assume every remote/cloud executor inherits it.",
      authIntro:
        "Follow an authorization prompt when offered. If the server still needs authentication, run codex mcp login moira and complete browser sign-in. An already authorized connection needs no repeat login.",
      authContent: "codex mcp login moira",
      verification:
        "Run codex mcp list and open /mcp in the active Codex session to check Moira's state and available tools.",
      tokenSteps:
        "Create a token in Moira → Settings → API Tokens. Set MOIRA_API_TOKEN in the environment of the process launching Codex. The TOML field below names that environment variable; it does not contain the token.",
    },
    "kimi-code": {
      setup:
        "Merge the direct configuration below into ~/.kimi-code/mcp.json, or .kimi-code/mcp.json for this project, and reload or start a new session. The direct configuration uses this selected server. Project configuration requires workspace trust; an unattended run cannot answer that prompt for you.",
      authIntro:
        "In Kimi Code, run /mcp-config login moira when authorization is needed and complete sign-in. The token configuration is an alternative.",
      authContent: "/mcp-config login moira",
      verification:
        "Use /mcp to inspect the actual server state. If using the optional hosted plugin, /plugins info moira shows its installation details.",
      alternativeTitle: "Optional: hosted Moira plugin",
      alternativeDescription:
        "This plugin connects to the fixed hosted endpoint https://moira-mcp.com/mcp, not to your selected self-host server. Use the direct configuration above for your own server. Install the repository tree below, then /reload or start a new session.",
    },
  },
  tokenAuth: {
    sectionTitle: "Alternative: API token",
    description:
      "Use a static API token when you choose token authentication instead of browser OAuth. Keep the token private.",
    steps:
      "Sign in to Moira → Settings → API Tokens and create a token. Replace moira_YOUR_TOKEN below with that token. Merge this alternative into the client's existing configuration instead of adding a second Moira entry.",
  },
};
