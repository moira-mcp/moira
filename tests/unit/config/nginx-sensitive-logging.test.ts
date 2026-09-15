import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";

const configs = ["nginx-root.conf", "nginx-app.conf"];

describe("nginx configuration", () => {
  test.each(configs)("%s excludes credential-bearing requests from access logs", (config) => {
    const source = readFileSync(resolve(process.cwd(), "config", config), "utf8");

    expect(source).toContain("map $uri $moira_access_loggable {");
    expect(source).toContain("~^/api/public/executions/materialize/ 0;");
    expect(source).toContain("/api/integrations/github/callback 0;");
    expect(source).toContain("~^/api/workspaces/transfers/ 0;");
    expect(source).toContain(
      "access_log /var/log/nginx/access.log combined if=$moira_access_loggable;",
    );
    expect(source).not.toMatch(/^\s*access_log \/var\/log\/nginx\/access\.log;\s*$/m);
  });

  test.each(configs)(
    "%s streams private workspace downloads from MCP without path logging",
    (config) => {
      const source = readFileSync(resolve(process.cwd(), "config", config), "utf8");
      const location = source.match(
        /location \^~ \/api\/workspaces\/transfers\/\s*\{([^}]+)\}/,
      )?.[1];
      expect(location).toBeDefined();
      expect(location).toContain("proxy_pass http://localhost:3000;");
      expect(location).toContain("proxy_buffering off;");
      expect(location).toContain("proxy_max_temp_file_size 0;");
      expect(location).toContain("access_log off;");
      expect(location).toContain("error_log /dev/null;");
    },
  );

  test.each(configs)(
    "%s routes bounded communication uploads to MCP without rewriting MIME",
    (config) => {
      const source = readFileSync(resolve(process.cwd(), "config", config), "utf8");

      expect(source).toContain("client_max_body_size 20m;");
      const location = source.slice(source.indexOf("location = /api/communication/attachments"));
      expect(location).toContain("proxy_pass http://localhost:3000/api/communication/attachments;");
      expect(location).toContain("proxy_set_header Authorization $http_authorization;");
      expect(location).toContain(
        "proxy_set_header X-Moira-Communication-Grant $http_x_moira_communication_grant;",
      );
      expect(location.split("}", 1)[0]).not.toContain('Content-Type "application/json"');
    },
  );
});
