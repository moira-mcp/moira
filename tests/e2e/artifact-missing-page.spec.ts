import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

test("missing and removed artifacts show a truthful page under nondefault retention", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsAdmin(page);
  const endpoint = `${BASE_URL}/api/admin/global-settings/artifacts.default_ttl_days`;
  const settingsResponse = await page.request.get(`${BASE_URL}/api/admin/global-settings`);
  expect(settingsResponse.status()).toBe(200);
  const settings = await settingsResponse.json();
  const retention = settings.data.settings.find(
    (setting: { key: string }) => setting.key === "artifacts.default_ttl_days",
  );
  expect(retention).toBeDefined();
  const created: string[] = [];
  try {
    for (const state of ["never-existing", "removed"] as const) {
      const configured = await page.request.put(endpoint, {
        data: { value: "7" },
      });
      expect(configured.status()).toBe(200);
      const published = await page.request.post(`${BASE_URL}/api/artifacts`, {
        data: { name: "Missing-page fixture", content: "<html><body>Fixture</body></html>" },
      });
      expect(published.status()).toBe(201);
      const artifact = (await published.json()).data;
      created.push(artifact.uuid);
      const url = new URL(artifact.url);
      if (state === "never-existing") {
        url.hostname = `${randomUUID()}.${url.hostname.split(".").slice(1).join(".")}`;
      } else if (state === "removed") {
        const removed = await page.request.delete(`${BASE_URL}/api/artifacts/${artifact.uuid}`);
        expect(removed.status()).toBe(200);
        created.pop();
      }
      const response = await page.goto(url.toString());
      expect(response?.status()).toBe(404);
      await expect(page.getByRole("heading", { name: "Artifact Not Found" })).toBeVisible();
      await expect(
        page.getByText(
          "This artifact may have expired, been removed, or never existed. Ask its author for a current link.",
        ),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`artifact-${state}.png`),
        animations: "disabled",
      });
    }
  } finally {
    const restored = await page.request.put(endpoint, { data: { value: retention.value } });
    expect(restored.status()).toBe(200);
    for (const uuid of created) {
      const removed = await page.request.delete(`${BASE_URL}/api/artifacts/${uuid}`);
      expect(removed.status()).toBe(200);
    }
  }
});
