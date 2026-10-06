import { describe, expect, it } from "@jest/globals";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { IncomingMessage, ServerResponse, ClientRequest } from "node:http";
import type { request as httpsRequest } from "node:https";
import { cloudGitBroker } from "../../../packages/local/src/cloud-git-broker.js";
import type { NetworkBudget } from "../../../packages/local/src/network-budget.js";
import type { BrokerGrant } from "../../../packages/local/src/broker.js";

const grant: BrokerGrant = {
  spaceId: "owned-space",
  generation: 3,
  gitCredential: null,
  repository: {
    id: "repository",
    fullName: "owner/private",
    private: true,
    allowPush: true,
    allowPullRequests: true,
    allowDelete: false,
    domains: [],
  },
  policy: { enabled: true, leaseUntil: Date.now() + 60000 } as BrokerGrant["policy"],
};
function incoming(relative: string, method = "POST", bytes = Buffer.from([255, 0, 1])) {
  return Object.assign(Readable.from([bytes]), {
    url: `/git/owner/private.git/${relative}`,
    method,
    headers: { authorization: "Basic guest-capability" },
  }) as unknown as IncomingMessage;
}
function output() {
  const chunks: Buffer[] = [];
  let status = 0;
  const response = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  Object.assign(response, {
    writeHead: (code: number) => {
      status = code;
      return response;
    },
    headersSent: false,
  });
  return { response: response as unknown as ServerResponse, chunks, status: () => status };
}
describe("cloud Git broker", () => {
  it("forwards raw pack bytes to the pinned relay and uses only the device credential", async () => {
    const forwarded: Buffer[] = [];
    let destination = "";
    let authorization = "";
    let accounted = 0;
    const requestHttps = ((
      url: URL,
      options: { headers: { authorization: string } },
      callback: (reply: IncomingMessage) => void,
    ) => {
      destination = url.toString();
      authorization = options.headers.authorization;
      const upstream = new Writable({
        write(chunk, _encoding, done) {
          forwarded.push(Buffer.from(chunk));
          done();
        },
      });
      upstream.once("finish", () =>
        callback(
          Object.assign(Readable.from([Buffer.from([0, 255, 2])]), {
            statusCode: 200,
            headers: { "content-type": "application/x-git-receive-pack-result" },
          }) as unknown as IncomingMessage,
        ),
      );
      return upstream as unknown as ClientRequest;
    }) as typeof httpsRequest;
    const budget = {
      reserve: async () => ({
        maximumBytes: 1024,
        release: async (bytes: number) => {
          accounted = bytes;
        },
      }),
    } as unknown as NetworkBudget;
    const broker = cloudGitBroker(
      async (spaceId, generation, repositoryId) => {
        if (spaceId !== "owned-space" || generation !== 3 || repositoryId !== "repository")
          throw Error("Denied");
        return {
          origin: "https://moira.example",
          credential: "device-secret",
          resourceId: "server-resource",
          resourceGeneration: 4,
        };
      },
      budget,
      (error) => {
        throw error;
      },
      async () => {
        throw Error("No legacy credential fallback allowed");
      },
      requestHttps,
    );
    const result = output();
    const completion = finished(result.response, { cleanup: true });
    await broker(incoming("git-receive-pack"), result.response, grant);
    await completion;
    expect(Buffer.concat(forwarded)).toEqual(Buffer.from([255, 0, 1]));
    expect(Buffer.concat(result.chunks)).toEqual(Buffer.from([0, 255, 2]));
    expect(destination).toBe(
      "https://moira.example/api/local-devices/github/server-resource/4/git/push",
    );
    expect(authorization).toBe("Bearer device-secret");
    expect(accounted).toBe(6);
  });
  it.each([
    "other.git/git-receive-pack",
    "git-receive-pack?url=https://attacker.test",
    "info/refs?service=git-upload-pack&extra=1",
  ])("rejects arbitrary or malformed paths before cloud authority", async (relative) => {
    const broker = cloudGitBroker(
      async () => {
        throw Error("Unexpected admission");
      },
      {} as NetworkBudget,
      () => {},
      async () => {
        throw Error("Unexpected fallback");
      },
    );
    const result = output();
    await broker(incoming(relative), result.response, grant);
    expect(result.status()).toBe(403);
  });
  it("does not fall back to stored tokens when confirmed cloud authority refuses", async () => {
    const broker = cloudGitBroker(
      async () => {
        throw Error("Revoked binding");
      },
      {} as NetworkBudget,
      () => {},
      async () => {
        throw Error("Secret fallback happened");
      },
    );
    await expect(
      broker(incoming("git-receive-pack"), output().response, {
        ...grant,
        gitCredential: "old-host-token",
      }),
    ).rejects.toThrow("Revoked binding");
  });
});
