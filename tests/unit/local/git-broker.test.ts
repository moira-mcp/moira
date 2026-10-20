import { describe, expect, it, jest } from "@jest/globals";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrokerGrant } from "../../../packages/local/src/broker.js";
import type { NetworkBudget } from "../../../packages/local/src/network-budget.js";
import { gitBroker } from "../../../packages/local/src/git-broker.js";
import { httpBroker } from "../../../packages/local/src/http-broker.js";
import { LocalRefusal } from "../../../packages/local/src/policy.js";

function grant(): BrokerGrant {
  return {
    spaceId: "owned-space",
    generation: 3,
    repository: {
      id: "repository",
      fullName: "owner/private",
      private: true,
      allowPush: true,
      allowPullRequests: true,
      allowDelete: false,
    },
    policy: { enabled: true } as BrokerGrant["policy"],
  };
}
function incoming(relative: string, method = "POST") {
  return Object.assign(Readable.from([Buffer.from([255, 0, 1])]), {
    url: `/git/owner/private.git/${relative}`,
    method,
    headers: {},
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
    headersSent: false,
    writeHead(code: number) {
      status = code;
      return response;
    },
  });
  return {
    response: response as unknown as ServerResponse,
    status: () => status,
    text: () => Buffer.concat(chunks).toString(),
  };
}
function budget(release = async () => {}) {
  return { reserve: async () => ({ release }) } as unknown as NetworkBudget;
}

describe("Local direct Git owner adapter", () => {
  it.each([false, true])(
    "public fetch uses anonymous authority only when write rights are absent (allowPush=%s)",
    async (allowPush) => {
      const current = grant();
      current.repository.private = false;
      current.repository.allowPush = allowPush;
      current.repository.allowPullRequests = false;
      const acquire = jest.fn(async () => {
        throw new LocalRefusal("LOCAL_NOT_ENROLLED", "No paired issuer");
      });
      const result = output();
      const handler = gitBroker(budget(), () => {}, acquire, {
        git: async (_request, response, authority) => {
          const lease = await authority.acquire("fetch", authority.signal);
          try {
            if (lease.mode === "anonymous") expect(lease.useUntil).toBeNull();
            response.end(
              lease.mode === "anonymous" ? "anonymous-direct-fetch" : "scoped-direct-fetch",
            );
          } finally {
            await lease.dispose();
          }
        },
        pullRequest: async () => {
          throw Error("Unexpected PR");
        },
      });
      await handler.git(
        incoming("info/refs?service=git-upload-pack", "GET"),
        result.response,
        current,
      );
      if (allowPush) {
        expect(result.status()).toBe(403);
        expect(result.text()).toContain("LOCAL_NOT_ENROLLED");
        expect(acquire).toHaveBeenCalledTimes(1);
      } else {
        expect(result.text()).toBe("anonymous-direct-fetch");
        expect(acquire).not.toHaveBeenCalled();
      }
    },
  );
  it("revoked push authority after network admission refuses before acquiring a credential", async () => {
    const current = grant();
    const acquire = jest.fn(async () => {
      throw Error("Revoked push reached issuance");
    });
    const result = output();
    const network = {
      reserve: async () => {
        current.repository.allowPush = false;
        return { release: async () => {} };
      },
    } as unknown as NetworkBudget;
    await gitBroker(network, () => {}, acquire).git(
      incoming("git-receive-pack"),
      result.response,
      current,
    );
    expect(result.status()).toBe(409);
    expect(JSON.parse(result.text()).error.code).toBe("CODESPACE_GITHUB_REJECTED");
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each([
    "other.git/git-receive-pack",
    "git-receive-pack?url=https://attacker.test",
    "info/refs?service=git-upload-pack&extra=1",
  ])("refuses an unbound smart HTTP path %s without issuance", async (relative) => {
    const acquire = jest.fn(async () => {
      throw Error("Invalid path reached issuance");
    });
    const result = output();
    await gitBroker(budget(), () => {}, acquire).git(incoming(relative), result.response, grant());
    expect(JSON.parse(result.text()).error.code).toBe("CODESPACE_GITHUB_REJECTED");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("confirmed issuer refusal never selects a stored-token or cloud Git fallback", async () => {
    const result = output();
    const adapter = gitBroker(
      budget(),
      () => {},
      async () => {
        throw new LocalRefusal("LOCAL_UNAUTHORIZED", "Authority refused");
      },
    );
    await adapter.git(incoming("git-receive-pack"), result.response, grant());
    expect(result.status()).toBe(403);
    expect(JSON.parse(result.text()).error.code).toBe("LOCAL_UNAUTHORIZED");
    expect(result.text()).not.toContain("token");
  });

  it("lost issuance exposes only its original security request for collect-before-repeat", async () => {
    const result = output(),
      requestId = "ws1-00000000-0000-4000-8000-000000000001";
    const adapter = gitBroker(
      budget(),
      () => {},
      async () => {
        throw Object.assign(
          new LocalRefusal("WORKSPACE_OUTCOME_UNCONFIRMED", "Lost issuer observation"),
          { securityRequestId: requestId },
        );
      },
    );
    await adapter.git(incoming("git-receive-pack"), result.response, grant());
    expect(result.status()).toBe(503);
    expect(JSON.parse(result.text()).error).toMatchObject({
      code: "WORKSPACE_OUTCOME_UNCONFIRMED",
      security_request_id: requestId,
    });
    expect(result.text()).not.toContain("refused");
  });

  it.each(["SCOPED_CREDENTIAL_CUSTODY_UNCONFIRMED", "SCOPED_CREDENTIAL_DISPOSAL_PENDING"])(
    "%s is outward uncertainty with its original security identity, never a refusal",
    async (code) => {
      const result = output(),
        requestId = "ws1-00000000-0000-4000-8000-000000000001";
      const adapter = gitBroker(
        budget(),
        () => {},
        async () => {
          throw Object.assign(
            new LocalRefusal(code, "Issuer capability retention is unconfirmed"),
            { securityRequestId: requestId },
          );
        },
      );
      await adapter.git(incoming("git-receive-pack"), result.response, grant());
      expect(result.status()).toBe(503);
      expect(JSON.parse(result.text()).error).toMatchObject({
        code,
        security_request_id: requestId,
        message: expect.stringContaining("unconfirmed"),
      });
      expect(result.text()).not.toContain("refused");
    },
  );

  it.each([
    ["SCOPED_CREDENTIAL_CUSTODY_UNCONFIRMED", "SCOPED_CREDENTIAL_CUSTODY_UNCONFIRMED"],
    ["SCOPED_CREDENTIAL_DISPOSAL_PENDING", "SCOPED_CREDENTIAL_DISPOSAL_PENDING"],
    ["WORKSPACE_OUTCOME_UNCONFIRMED", "SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED"],
  ])(
    "actual fixed PR owner keeps %s uncertainty in credential scope before provider dispatch",
    async (code, expectedCode) => {
      const result = output(),
        requestId = "ws1-00000000-0000-4000-8000-000000000001";
      const adapter = gitBroker(
        budget(),
        () => {},
        async () => {
          throw Object.assign(new LocalRefusal(code, "Issuer outcome is unconfirmed"), {
            securityRequestId: requestId,
          });
        },
      );
      const request = Object.assign(
        Readable.from([JSON.stringify({ head: "feature", base: "main", title: "Approved PR" })]),
        {
          url: "/github/pull_request_create",
          method: "POST",
          headers: {},
        },
      ) as unknown as IncomingMessage;
      await adapter.pullRequest!(request, result.response, grant());
      expect(result.status()).toBe(503);
      expect(JSON.parse(result.text()).error).toMatchObject({
        code: expectedCode,
        security_request_id: requestId,
        message: expect.stringContaining("unconfirmed"),
      });
      expect(result.text()).not.toContain("refused");
    },
  );

  it.each(["git", "http"] as const)(
    "a late %s reservation closes without opening its destination",
    async (kind) => {
      let enter!: () => void, resume!: () => void;
      const entered = new Promise<void>((done) => {
          enter = done;
        }),
        held = new Promise<void>((done) => {
          resume = done;
        });
      let released = false;
      const network = {
        reserve: async () => {
          enter();
          await held;
          return {
            release: async () => {
              released = true;
            },
          };
        },
      } as unknown as NetworkBudget;
      const acquire = jest.fn(async () => {
        throw Error("Closed observer reached issuer");
      });
      const resolve = jest.fn(async () => {
        throw Error("Closed observer reached DNS");
      });
      const handler =
        kind === "git"
          ? gitBroker(network, () => {}, acquire).git
          : httpBroker(network, () => {}, resolve);
      const result = output(),
        request = incoming("git-receive-pack");
      if (kind === "http") {
        request.url = "http://packages.example.com/package";
        request.method = "GET";
      }
      const work = handler(request, result.response, grant());
      await entered;
      result.response.destroy();
      resume();
      await work;
      expect(released).toBe(true);
      expect(acquire).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    },
  );
});
