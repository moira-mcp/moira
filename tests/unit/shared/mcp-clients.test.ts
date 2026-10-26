import { execFileSync } from "node:child_process";
import { describe, it, expect } from "@jest/globals";
import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "smol-toml";
import {
  getClientById,
  getClientsByCategory,
  getClientIds,
  CLIENT_COUNT,
  configGenerators,
  tokenConfigGenerators,
  generateCursorDeeplink,
  generateVSCodeDeeplink,
  getClientSetupPresentation,
  resolveClientDeeplink,
} from "@mcp-moira/shared/mcp-clients";

const configuredUrl = "https://self.example/путь?x=a'b&value=$&";
const bearer = "Bearer moira_YOUR_TOKEN";

describe("MCP client configuration", () => {
  it("offers the supported clients, including Codex and Kimi, without duplicate tabs", () => {
    expect(getClientIds()).toEqual([
      "claude-code",
      "copilot-cli",
      "cursor",
      "claude-desktop",
      "vscode",
      "claude-web",
      "chatgpt",
      "perplexity",
      "continue",
      "zed",
      "gemini-cli",
      "codex",
      "kimi-code",
    ]);
    expect(CLIENT_COUNT).toBe(13);
    expect(getClientById("codex")?.name).toBe("Codex");
    expect(getClientById("unknown")).toBeUndefined();
    expect(getClientsByCategory("web").map(({ id }) => id)).toEqual([
      "claude-web",
      "chatgpt",
      "perplexity",
    ]);
  });

  it.each(["mcp-json", "claude-code-json", "copilot-cli-json", "gemini-cli-json"] as const)(
    "%s retains its native JSON transport and the exact selected endpoint",
    (id) => {
      const parsed = JSON.parse(configGenerators[id](configuredUrl));
      const entry = parsed.mcpServers.moira;
      if (id === "gemini-cli-json") {
        expect(entry).toEqual({ httpUrl: configuredUrl });
      } else if (id === "mcp-json") {
        expect(entry).toEqual({ url: configuredUrl });
      } else if (id === "copilot-cli-json") {
        expect(entry).toEqual({ type: "http", url: configuredUrl, tools: ["*"] });
      } else {
        expect(entry).toEqual({ type: "http", url: configuredUrl });
      }
    },
  );

  it("uses VS Code servers and Zed context_servers instead of generic mcpServers", () => {
    expect(JSON.parse(configGenerators["vscode-json"](configuredUrl))).toEqual({
      servers: { moira: { type: "http", url: configuredUrl } },
    });
    expect(JSON.parse(configGenerators["zed-json"](configuredUrl))).toEqual({
      context_servers: { moira: { url: configuredUrl } },
    });
  });

  it("parses Continue as an active YAML fragment with Streamable HTTP and nested token headers", () => {
    const primary = getClientSetupPresentation("en", configuredUrl).find(
      ({ client }) => client.id === "continue",
    )!;
    const parsed = parseYaml(primary.primary!.code);
    expect(parsed).toEqual({
      mcpServers: [
        {
          name: "moira",
          type: "streamable-http",
          url: configuredUrl,
          requestOptions: { headers: { Authorization: bearer } },
        },
      ],
    });
    expect(primary.tokenAuth).toBeUndefined();
  });

  it("parses Codex TOML without treating a token environment variable as a token value", () => {
    const expected = { mcp_servers: { moira: { url: configuredUrl } } };
    expect(parseToml(configGenerators["codex-toml"](configuredUrl))).toEqual(expected);
    expect(parseToml(tokenConfigGenerators["codex-toml-token"](configuredUrl))).toEqual({
      mcp_servers: { moira: { url: configuredUrl, bearer_token_env_var: "MOIRA_API_TOKEN" } },
    });
  });

  it.each([
    ["mcp-json-token", "mcpServers", { url: configuredUrl }],
    ["claude-code-json-token", "mcpServers", { type: "http", url: configuredUrl }],
    ["copilot-cli-json-token", "mcpServers", { type: "http", url: configuredUrl, tools: ["*"] }],
    ["vscode-json-token", "servers", { type: "http", url: configuredUrl }],
    ["zed-json-token", "context_servers", { url: configuredUrl }],
    ["gemini-cli-json-token", "mcpServers", { httpUrl: configuredUrl }],
  ] as const)("%s puts bearer auth in its client's native entry", (id, key, entry) => {
    expect(JSON.parse(tokenConfigGenerators[id](configuredUrl))).toEqual({
      [key]: { moira: { ...entry, headers: { Authorization: bearer } } },
    });
  });

  it.each([
    ["claude-code-cli", "claude", ["mcp", "add", "--transport", "http", "moira"]],
    ["copilot-cli-command", "copilot", ["mcp", "add", "--transport", "http", "moira"]],
    ["gemini-cli-command", "gemini", ["mcp", "add", "--transport", "http", "moira"]],
    ["codex-cli", "codex", ["mcp", "add", "moira", "--url"]],
  ] as const)(
    "%s passes a special-character URL as one literal shell argument",
    (id, binary, prefix) => {
      const url = `${configuredUrl}&d=$HOME&sub=$(printf WRONG)&tick=\`printf WRONG\`&quote="`;
      const output = execFileSync("/bin/sh", [
        "-c",
        `${binary}() { printf '%s\\0' "$@"; }; ${configGenerators[id](url)}`,
      ]);
      expect(output.toString().split("\0").slice(0, -1)).toEqual([...prefix, url]);
    },
  );

  it("decodes Cursor and VS Code install links to one native server with the selected URL", () => {
    const cursor = new URL(generateCursorDeeplink(configuredUrl));
    expect(cursor.searchParams.get("name")).toBe("moira");
    expect(
      JSON.parse(Buffer.from(cursor.searchParams.get("config")!, "base64").toString("utf8")),
    ).toEqual({ url: configuredUrl });
    const vscode = generateVSCodeDeeplink(configuredUrl);
    expect(JSON.parse(decodeURIComponent(vscode.split("?")[1]))).toEqual({
      name: "moira",
      type: "http",
      url: configuredUrl,
    });
    const presentation = getClientSetupPresentation("en", configuredUrl).find(
      ({ client }) => client.id === "vscode",
    )!;
    expect(resolveClientDeeplink(presentation, configuredUrl)).toBe(vscode);
  });

  it.each(["en", "ru"] as const)(
    "%s gives ChatGPT a direct setup link while retaining the selected server URL",
    (language) => {
      const presentation = getClientSetupPresentation(language, configuredUrl).find(
        ({ client }) => client.id === "chatgpt",
      )!;
      expect(resolveClientDeeplink(presentation, configuredUrl)).toBe(
        "https://chatgpt.com/plugins",
      );
      expect(presentation.deeplink?.label).toBe(
        language === "en" ? "Open ChatGPT plugins" : "Открыть плагины ChatGPT",
      );
      expect(presentation.primary?.code).toBe(configuredUrl);
    },
  );

  it.each(["en", "ru"] as const)(
    "%s presents GUI endpoints as copyable URLs and keeps hosted Kimi optional",
    (language) => {
      const presentations = getClientSetupPresentation(language, configuredUrl);
      const gui = presentations.filter(({ client }) => client.setupType === "gui");
      expect(gui.map(({ client }) => client.id)).toEqual([
        "claude-desktop",
        "claude-web",
        "chatgpt",
        "perplexity",
      ]);
      for (const { primary } of gui)
        expect(primary).toEqual({
          code: configuredUrl,
          language: "text",
          title: language === "en" ? "Server URL" : "URL сервера",
        });
      const kimi = presentations.find(({ client }) => client.id === "kimi-code")!;
      expect(JSON.parse(kimi.primary!.code)).toEqual({
        mcpServers: { moira: { url: configuredUrl } },
      });
      expect(kimi.alternativeDescription).toContain("https://moira-mcp.com/mcp");
      expect(kimi.alternative!.code).toBe(
        "/plugins install https://github.com/moira-mcp/moira/tree/master\n/reload",
      );
    },
  );

  it("gives an injected client truthful generic guidance instead of missing localization keys", () => {
    const client = {
      ...getClientById("cursor")!,
      id: "fixture-editor",
      name: "Fixture editor",
      description: "Fixture client instructions",
    };
    const [presentation] = getClientSetupPresentation("en", configuredUrl, [client]);
    expect(presentation.label).toBe("Fixture editor");
    expect(presentation.setup).toBe("Fixture client instructions");
    expect(presentation.authIntro).toContain("official client documentation");
    expect(presentation.verification).toContain("read-only list tool");
    expect(presentation.alternative?.code).toBe(configGenerators["mcp-json"](configuredUrl));
    expect(JSON.stringify(presentation)).not.toContain("quickStart.tabs.");
  });
});
