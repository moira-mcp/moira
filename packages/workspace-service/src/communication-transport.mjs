import { request } from "node:https";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { connectHttps, transportClosed } from "./tls-transport.mjs";
import { encodeOwnerFrame, OWNER_STREAM_CONTENT_TYPE } from "./stream-frame.mjs";
import {
  communicationOwnerPrepareSchema,
  communicationOwnerSendSchema,
} from "../../shared/src/communication-owner-protocol.ts";

/** Fixed trusted cloud endpoints; no vendor address or secret is accepted from the file caller. */
export function createOwnerCommunicationTransport({ origin, credential, proxy }) {
  const target = new URL(origin);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error("Invalid communication authority origin");
  const invoke = async (path, input, body, signal, binary = false, extraHeaders = {}) => {
    let socket,
      outgoing,
      incoming,
      writing,
      uploadComplete = false,
      submitted = false;
    try {
      socket = await connectHttps({
        hostname: target.hostname,
        port: Number(target.port || 443),
        proxy,
        signal,
      });
      const framed = body ? encodeOwnerFrame(input, body) : undefined;
      const response = new Promise((resolve, reject) => {
        const headers = {
          authorization: `Bearer ${credential}`,
          ...extraHeaders,
          ...(body
            ? {
                "content-type": OWNER_STREAM_CONTENT_TYPE,
                "content-length": String(framed.prefixLength + input.file.size),
              }
            : { "content-type": "application/json" }),
        };
        outgoing = request(
          {
            hostname: target.hostname,
            port: Number(target.port || 443),
            path: target.pathname.replace(/\/$/, "") + path,
            method: binary ? "GET" : "POST",
            signal,
            createConnection: () => socket,
            headers,
          },
          resolve,
        );
        outgoing.once("error", reject);
      });
      submitted = true;
      writing = (async () => {
        if (body) {
          for await (const bytes of framed.body)
            await new Promise((resolve, reject) =>
              outgoing.write(bytes, (error) => (error ? reject(error) : resolve())),
            );
          outgoing.end();
          uploadComplete = true;
        } else outgoing.end(binary ? undefined : JSON.stringify(input));
      })();
      void writing.catch(() => undefined);
      // A provider can refuse before the body finishes; destroy the request and settle its source.
      incoming = await response;
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      if (incoming.statusCode !== 200) {
        outgoing.destroy();
        await body?.close();
        await body?.settled;
        await writing.catch(() => undefined);
        throw Object.assign(new Error("Communication authority refused or lost the reply"), {
          publicCode:
            body && incoming.statusCode >= 500
              ? "WORKSPACE_OUTCOME_UNCONFIRMED"
              : "COMMUNICATION_AUTHORITY_REFUSED",
          status: incoming.statusCode,
          deliveryOutcome:
            body && [400, 401, 403, 404, 409, 422].includes(incoming.statusCode)
              ? "refused"
              : "unconfirmed",
        });
      }
      if (body && !uploadComplete) {
        outgoing.destroy();
        await body.close();
        await body.settled;
        throw Object.assign(new Error("Communication reply preceded complete source upload"), {
          publicCode: "WORKSPACE_OUTCOME_UNCONFIRMED",
          status: 503,
        });
      }
      await writing;
      return binary ? Buffer.concat(chunks) : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error.publicCode) throw error;
      throw Object.assign(new Error("Communication transport is unavailable"), {
        publicCode:
          body && submitted ? "WORKSPACE_OUTCOME_UNCONFIRMED" : "COMMUNICATION_OWNER_UNAVAILABLE",
        status: 503,
      });
    } finally {
      incoming?.destroy();
      outgoing?.destroy();
      await body?.close();
      await body?.settled;
      await writing?.catch(() => undefined);
      if (socket) {
        const settled = transportClosed(socket);
        socket.destroy();
        await settled;
      }
    }
  };
  return {
    prepare(input, signal) {
      return invoke(
        "/api/communication/owner/prepare",
        communicationOwnerPrepareSchema.parse(input),
        undefined,
        signal,
      );
    },
    send(input, source, signal) {
      return invoke(
        "/api/communication/owner/send",
        communicationOwnerSendSchema.parse(input),
        source,
        signal,
      );
    },
    async artifact(channelId, digest, scope, signal) {
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid installed artifact identity");
      return {
        digest,
        bytes: await invoke(
          "/api/communication/owner/artifacts/" + encodeURIComponent(channelId) + "/" + digest,
          undefined,
          undefined,
          signal,
          true,
          {
            "x-moira-communication-scope": Buffer.from(JSON.stringify(scope)).toString("base64url"),
          },
        ),
      };
    },
  };
}
