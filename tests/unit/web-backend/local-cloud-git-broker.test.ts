import { describe, expect, it, jest } from "@jest/globals";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { IncomingMessage, ServerResponse, ClientRequest } from "node:http";
import type { request as httpsRequest } from "node:https";
import { cloudGitBroker } from "../../../packages/local/src/cloud-git-broker.js";
import type { NetworkBudget } from "../../../packages/local/src/network-budget.js";
import type { BrokerGrant } from "../../../packages/local/src/broker.js";
import { gitBroker } from "../../../packages/local/src/git-broker.js";
import { httpBroker } from "../../../packages/local/src/http-broker.js";

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
  it.each(["git", "cloud"] as const)(
    "%s push cannot use permission revoked while its connection was waiting",
    async (kind) => {
      const fresh = {
        ...grant,
        repository: { ...grant.repository },
        gitCredential: "fixed-test-token",
      };
      const release = jest.fn(async () => {});
      const reserve = jest.fn(async () => {
        fresh.repository.allowPush = false;
        return { maximumBytes: 1024, release };
      });
      const authority = jest.fn(async () => {
        throw Error("Revoked push reached authority");
      });
      const resolve = jest.fn(async () => {
        throw Error("Revoked push reached DNS");
      });
      const requestHttps = jest.fn(() => {
        throw Error("Revoked push reached HTTPS");
      });
      const budget = { reserve } as unknown as NetworkBudget;
      const broker =
        kind === "cloud"
          ? cloudGitBroker(
              authority,
              budget,
              () => {},
              async () => {
                throw Error("Unexpected fallback");
              },
              requestHttps as unknown as typeof httpsRequest,
            )
          : gitBroker(budget, () => {}, resolve, requestHttps as unknown as typeof httpsRequest);
      const result = output();
      await broker(incoming("git-receive-pack"), result.response, fresh);
      expect(result.status()).toBe(403);
      expect(authority).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(requestHttps).not.toHaveBeenCalled();
      expect(release.mock.calls).toEqual([[0]]);
    },
  );

  it("keeps its handler active until downstream shutdown closes HTTPS and refunds its reservation", async () => {
    let enterClose!: () => void;
    let finishClose!: () => void;
    let enterRelease!: () => void;
    let finishRelease!: () => void;
    const closing = new Promise<void>((resolve) => {
      enterClose = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const releasing = new Promise<void>((resolve) => {
      enterRelease = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const release = jest.fn(async () => {
      enterRelease();
      await releaseGate;
    });
    const requestHttps = ((
      _url: URL,
      _options: unknown,
      callback: (reply: IncomingMessage) => void,
    ) => {
      const upstream = new Writable({
        autoDestroy: false,
        write(_chunk, _encoding, done) {
          done();
        },
        destroy(_error, done) {
          enterClose();
          void closeGate.then(() => done(null));
        },
      });
      upstream.once("finish", () =>
        callback(
          Object.assign(Readable.from([Buffer.from("reply")]), {
            statusCode: 200,
            headers: {},
          }) as unknown as IncomingMessage,
        ),
      );
      return upstream as unknown as ClientRequest;
    }) as typeof httpsRequest;
    const broker = cloudGitBroker(
      async () => ({
        origin: "https://moira.example",
        credential: "device-secret",
        resourceId: "server-resource",
        resourceGeneration: 4,
      }),
      { reserve: async () => ({ maximumBytes: 1024, release }) } as unknown as NetworkBudget,
      () => {},
      async () => {
        throw Error("No fallback expected");
      },
      requestHttps,
    );
    const result = output();
    let completed = false;
    const work = broker(incoming("git-receive-pack"), result.response, grant).then(() => {
      completed = true;
    });
    await Promise.all([closing, releasing]);
    try {
      expect(completed).toBe(false);
      finishRelease();
      await Promise.resolve();
      expect(completed).toBe(false);
    } finally {
      finishRelease();
      finishClose();
      await work;
    }
    expect(release).toHaveBeenCalledTimes(1);
    expect(completed).toBe(true);
  });

  it.each(["authority", "reservation"] as const)(
    "does not open HTTPS when its downstream closes during %s",
    async (phase) => {
      let enter!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const release = jest.fn(async () => {});
      const reserve = jest.fn(async () => {
        if (phase === "reservation") {
          enter();
          await gate;
        }
        return { maximumBytes: 1024, release };
      });
      const requestHttps = jest.fn(() => {
        throw Error("Closed request reached HTTPS");
      });
      const broker = cloudGitBroker(
        async () => {
          if (phase === "authority") {
            enter();
            await gate;
          }
          return {
            origin: "https://moira.example",
            credential: "device-secret",
            resourceId: "server-resource",
            resourceGeneration: 4,
          };
        },
        { reserve } as unknown as NetworkBudget,
        () => {},
        async () => {
          throw Error("No fallback expected");
        },
        requestHttps as unknown as typeof httpsRequest,
      );
      const result = output();
      const work = broker(incoming("git-receive-pack"), result.response, grant);
      await entered;
      result.response.destroy();
      resume();
      await work;
      expect(requestHttps).not.toHaveBeenCalled();
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(release.mock.calls).toEqual([[0]]);
    },
  );

  it.each(["git", "http"] as const)(
    "%s broker refunds a late reservation without resolving or opening its destination",
    async (kind) => {
      let enter!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const release = jest.fn(async () => {});
      const budget = {
        reserve: async () => {
          enter();
          await gate;
          return { maximumBytes: 1024, release };
        },
      } as unknown as NetworkBudget;
      const resolve = jest.fn(async () => {
        throw Error("Closed request reached DNS");
      });
      const requestHttps = jest.fn(() => {
        throw Error("Closed request reached HTTPS");
      });
      const broker =
        kind === "git"
          ? gitBroker(budget, () => {}, resolve, requestHttps as unknown as typeof httpsRequest)
          : httpBroker(budget, () => {}, resolve);
      const result = output();
      const request =
        kind === "git"
          ? incoming("git-receive-pack")
          : Object.assign(incoming(""), {
              url: "http://packages.example.com/package",
              method: "GET",
            });
      const work = broker(request, result.response, {
        ...grant,
        gitCredential: "fixed-test-token",
      });
      await entered;
      result.response.destroy();
      resume();
      await work;
      expect(resolve).not.toHaveBeenCalled();
      expect(requestHttps).not.toHaveBeenCalled();
      expect(release.mock.calls).toEqual([[0]]);
    },
  );

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
    const release = jest.fn(async () => {});
    const broker = cloudGitBroker(
      async () => {
        throw Error("Revoked binding");
      },
      { reserve: async () => ({ maximumBytes: 1024, release }) } as unknown as NetworkBudget,
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
    expect(release.mock.calls).toEqual([[0]]);
  });
});
