import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";

const configs = ["nginx-root.conf", "nginx-app.conf"];

describe("nginx sensitive request logging", () => {
  test.each(configs)("%s excludes materialize bearer credentials from access logs", (config) => {
    const source = readFileSync(resolve(process.cwd(), "config", config), "utf8");

    expect(source).toContain("map $uri $moira_access_loggable {");
    expect(source).toContain("~^/api/public/executions/materialize/ 0;");
    expect(source).toContain(
      "access_log /var/log/nginx/access.log combined if=$moira_access_loggable;",
    );
    expect(source).not.toMatch(/^\s*access_log \/var\/log\/nginx\/access\.log;\s*$/m);
  });
});
