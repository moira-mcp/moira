import { describe, expect, jest, test } from "@jest/globals";

import { createTestOriginFetch } from "../../utils/test-origin-fetch.js";

function responseFetch() {
  return jest.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
}

describe("test Origin fetch", () => {
  test("adds the public browser origin to unsafe auth requests", async () => {
    const fetchImplementation = responseFetch();
    const wrapped = createTestOriginFetch(fetchImplementation, () => "http://localhost:3032");

    await wrapped("http://192.0.2.1:3032/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const [, init] = fetchImplementation.mock.calls[0];
    expect(new Headers(init?.headers).get("Origin")).toBe("http://localhost:3032");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
  });

  test("preserves an explicit Origin header", async () => {
    const fetchImplementation = responseFetch();
    const wrapped = createTestOriginFetch(fetchImplementation, () => "http://localhost:3032");

    await wrapped("http://localhost:3032/api/auth/sign-up/email", {
      method: "POST",
      headers: { Origin: "https://explicit.example" },
    });

    const [, init] = fetchImplementation.mock.calls[0];
    expect(new Headers(init?.headers).get("Origin")).toBe("https://explicit.example");
  });

  test.each([
    ["safe auth request", "http://localhost:3032/api/auth/session", { method: "GET" }],
    ["non-auth request", "http://localhost:3032/api/tokens", { method: "POST" }],
  ])("leaves a %s unchanged", async (_label, url, init) => {
    const fetchImplementation = responseFetch();
    const wrapped = createTestOriginFetch(fetchImplementation, () => "http://localhost:3032");

    await wrapped(url, init);

    expect(fetchImplementation).toHaveBeenCalledWith(url, init);
  });
});
