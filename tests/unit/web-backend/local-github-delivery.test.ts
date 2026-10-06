import { describe, expect, it } from "@jest/globals";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { IncomingMessage, ServerResponse, ClientRequest } from "node:http";
import type { request as httpsRequest } from "node:https";
import {
  LocalDeviceError,
  type CodespaceConnectionSnapshot,
  type LocalDeviceAuth,
} from "@mcp-moira/shared";
import {
  LocalGitHubDelivery,
  createPullRequestSchema,
  type LocalGitHubDeliveryDependencies,
} from "../../../packages/web-backend/src/services/local-github-delivery.js";

const auth: LocalDeviceAuth = {
  userId: "owner",
  deviceId: "00000000-0000-4000-8000-000000000001",
  deviceGeneration: 1,
  connectionId: "00000000-0000-4000-8000-000000000002",
};
function fixture(
  overrides: Partial<Pick<LocalGitHubDeliveryDependencies, "requestHttps" | "fetch">> = {},
) {
  let allowed = true;
  let stale = false;
  const requested: Array<{ url: string; body: unknown }> = [];
  const connection: CodespaceConnectionSnapshot = {
    id: "github-connection",
    userId: "owner",
    provider: "github-codespaces",
    externalAccountId: "123",
    externalLogin: "owner",
    status: "connected",
    credentialGeneration: 1,
    lastErrorCode: null,
    installations: [{ externalInstallationId: "99", repositorySelection: "selected" }],
    repositories: [
      {
        externalInstallationId: "99",
        externalRepositoryId: "456",
        fullName: "owner/private",
        private: true,
      },
    ],
  };
  let reply = {
    number: 7,
    html_url: "https://github.com/owner/private/pull/7",
    state: "open",
    title: "Change",
    draft: false,
    head: { ref: "feature/change" },
    base: { ref: "main" },
  };
  let status = 201;
  let listReply = false;
  const delivery = new LocalGitHubDelivery({
    connection: {
      refreshGrants: async () => ({ refreshed: true, stale }),
      getAccessToken: async () => "cloud-only-token",
    },
    connections: { getConnection: () => connection },
    authorize: (who, id, generation, permission) => {
      if (
        !allowed ||
        who.userId !== "owner" ||
        id !== "resource" ||
        generation !== 3 ||
        (permission !== "fetch" && permission !== "push" && permission !== "pull_request")
      )
        throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Denied");
      return {
        id: "repository",
        fullName: "owner/private",
        private: true,
        allowPush: true,
        allowPullRequests: true,
        allowDelete: false,
        domains: [],
      };
    },
    fetch: (async (url, init) => {
      requested.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(listReply ? [reply] : reply), { status });
    }) as typeof fetch,
    ...overrides,
  });
  return {
    delivery,
    requested,
    connection,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setStale: () => {
      stale = true;
    },
    setReply: (value: typeof reply) => {
      reply = value;
    },
    setStatus: (value: number) => {
      status = value;
    },
    setListReply: () => {
      listReply = true;
    },
  };
}
describe("local GitHub delivery", () => {
  it.each(["feat/игра", "feat/🚀", "_work", "+topic", "@"])(
    "creates and recovers a PR for Git-valid branch %s without changing its name",
    async (head) => {
      const f = fixture();
      f.setReply({
        number: 7,
        html_url: "https://github.com/owner/private/pull/7",
        state: "open",
        title: "Change",
        draft: false,
        head: { ref: head },
        base: { ref: "main" },
      });
      expect(
        await f.delivery.createPullRequest(auth, "resource", 3, {
          head,
          base: "main",
          title: "Change",
        }),
      ).toMatchObject({ head, base: "main", url: "https://github.com/owner/private/pull/7" });
      f.setListReply();
      expect(
        await f.delivery.findPullRequests(auth, "resource", 3, { head, base: "main" }),
      ).toHaveLength(1);
      const query = new URL(f.requested[1].url);
      expect(query.searchParams.get("head")).toBe(`owner:${head}`);
    },
  );
  it("finds an unknown creation receipt by exact owner, head and base without an arbitrary API", async () => {
    const f = fixture();
    f.setListReply();
    expect(
      await f.delivery.findPullRequests(auth, "resource", 3, {
        head: "feature/change",
        base: "main",
      }),
    ).toEqual([
      {
        number: 7,
        url: "https://github.com/owner/private/pull/7",
        state: "open",
        title: "Change",
        draft: false,
        head: "feature/change",
        base: "main",
      },
    ]);
    expect(f.requested[0].url).toBe(
      "https://api.github.com/repos/owner/private/pulls?state=open&head=owner%3Afeature%2Fchange&base=main&per_page=100",
    );
    expect(
      await f.delivery.findPullRequests(auth, "resource", 3, { head: "other", base: "main" }),
    ).toEqual([]);
    await expect(
      f.delivery.findPullRequests(auth, "resource", 3, {
        head: "other-owner:feature",
        base: "main",
      }),
    ).rejects.toThrow();
  });
  it("streams raw Git pack bytes only to the bound repository and returns no upstream credentials", async () => {
    const requestBytes = Buffer.from([0, 255, 1, 2, 0, 10]);
    const replyBytes = Buffer.from([255, 0, 11, 12]);
    const received: Buffer[] = [];
    let upstreamPath = "";
    const requestHttps = ((
      options: { path: string },
      callback: (reply: IncomingMessage) => void,
    ) => {
      upstreamPath = options.path;
      const upstream = new Writable({
        write(chunk, _encoding, done) {
          received.push(Buffer.from(chunk));
          done();
        },
      });
      upstream.once("finish", () => {
        const reply = Object.assign(Readable.from([replyBytes]), {
          statusCode: 200,
          headers: { "content-type": "application/x-git-receive-pack-result" },
        }) as unknown as IncomingMessage;
        callback(reply);
        upstream.emit("response", reply);
      });
      return upstream as unknown as ClientRequest;
    }) as typeof httpsRequest;
    const f = fixture({ requestHttps });
    const incoming = Object.assign(Readable.from([requestBytes]), {
      method: "POST",
      headers: { authorization: "guest-broker-capability", "git-protocol": "version=2" },
    }) as unknown as IncomingMessage;
    const output: Buffer[] = [];
    const response = new Writable({
      write(chunk, _encoding, done) {
        output.push(Buffer.from(chunk));
        done();
      },
    });
    Object.assign(response, { writeHead: () => response, headersSent: false });
    const completion = finished(response, { cleanup: true });
    await f.delivery.git(
      auth,
      "resource",
      3,
      "push",
      incoming,
      response as unknown as ServerResponse,
    );
    await completion;
    expect(Buffer.concat(received)).toEqual(requestBytes);
    expect(Buffer.concat(output)).toEqual(replyBytes);
    expect(upstreamPath).toBe("/owner/private.git/git-receive-pack");
    expect(Buffer.concat(output).toString()).not.toContain("cloud-only-token");
  });
  it("marks an interrupted PR mutation as unknown instead of safe to retry", async () => {
    const f = fixture({
      fetch: async () => {
        throw new Error("network body secret");
      },
    });
    await expect(
      f.delivery.createPullRequest(auth, "resource", 3, {
        head: "feature/change",
        base: "main",
        title: "Change",
      }),
    ).rejects.toThrow("outcome is unknown");
  });
  it("creates and reads a PR only in the cloud-authorized bound repository without exposing credentials", async () => {
    const f = fixture();
    const created = await f.delivery.createPullRequest(auth, "resource", 3, {
      head: "feature/change",
      base: "main",
      title: "Change",
    });
    expect(created).toEqual({
      number: 7,
      url: "https://github.com/owner/private/pull/7",
      state: "open",
      title: "Change",
      draft: false,
      head: "feature/change",
      base: "main",
    });
    const read = await f.delivery.getPullRequest(auth, "resource", 3, 7);
    expect(read).toEqual(created);
    expect(f.requested).toEqual([
      {
        url: "https://api.github.com/repos/owner/private/pulls",
        body: { head: "feature/change", base: "main", title: "Change", body: "", draft: false },
      },
      { url: "https://api.github.com/repos/owner/private/pulls/7", body: undefined },
    ]);
    expect(JSON.stringify(created)).not.toContain("cloud-only-token");
    expect(await f.delivery.identity(auth, "resource", 3)).toEqual({
      name: "owner",
      email: "123+owner@users.noreply.github.com",
    });
  });
  it.each([
    "another-owner",
    "stale-generation",
    "local-revoked",
    "github-revoked",
    "grants-unavailable",
  ])("refuses %s without sending a GitHub mutation", async (reason) => {
    const f = fixture();
    if (reason === "local-revoked") f.setAllowed(false);
    if (reason === "github-revoked") f.connection.repositories = [];
    if (reason === "grants-unavailable") f.setStale();
    await expect(
      f.delivery.createPullRequest(
        reason === "another-owner" ? { ...auth, userId: "other" } : auth,
        "resource",
        reason === "stale-generation" ? 2 : 3,
        { head: "feature/change", base: "main", title: "Change" },
      ),
    ).rejects.toBeInstanceOf(LocalDeviceError);
    expect(f.requested).toEqual([]);
  });
  it.each([
    { head: "other:branch", base: "main", title: "Change" },
    { head: "foo/.hidden", base: "main", title: "Change" },
    { head: "foo.lock", base: "main", title: "Change" },
    { head: "foo.lock/bar", base: "main", title: "Change" },
    { head: "foo//bar", base: "main", title: "Change" },
    { head: "feat\u007f", base: "main", title: "Change" },
    { head: "feat\ncommand", base: "main", title: "Change" },
    { head: "a".repeat(256), base: "main", title: "Change" },
    { head: "../branch", base: "main", title: "Change" },
    { head: "main", base: "main", title: "Change" },
    { head: "feature", base: "main", title: "Change", url: "https://attacker.test" },
  ])("rejects arbitrary API, fork, malformed Git branch, or equal-branch input", (input) => {
    expect(createPullRequestSchema.safeParse(input).success).toBe(false);
  });
  it("refuses provider URLs outside the approved repository", async () => {
    const f = fixture();
    f.setReply({
      number: 7,
      html_url: "https://github.com/other/private/pull/7",
      state: "open",
      title: "Change",
      draft: false,
      head: { ref: "feature/change" },
      base: { ref: "main" },
    });
    await expect(f.delivery.getPullRequest(auth, "resource", 3, 7)).rejects.toThrow(
      "outside the approved repository",
    );
  });
  it("returns a concrete installation permission repair without forwarding provider response secrets", async () => {
    const f = fixture();
    f.setStatus(403);
    await expect(
      f.delivery.createPullRequest(auth, "resource", 3, {
        head: "feature/change",
        base: "main",
        title: "Change",
      }),
    ).rejects.toThrow("Contents and Pull requests");
  });
});
