/**
 * Moira's side of the boundary: an HTTP client for the extension runner service.
 *
 * Its whole job is to turn network reality into the four failure classes the node handler already
 * routes: a service that cannot be reached is `runner-unavailable`, a call that outlives its
 * deadline is `timeout`, a handler that failed is `handler-error`, and a result that does not match
 * its declared schema is `invalid-output`. Collapsing them would leave a workflow author unable to
 * tell "my extension is broken" from "the runner is not running".
 */

import {
  ExtensionInvocationError,
  type ExtensionFailureKind,
  type ExtensionInvocationRequest,
  type ExtensionInvocationResult,
  type IExtensionRunnerClient,
} from "./extension-runner-client.js";
import type { ExtensionManifest } from "./extension-contract.js";

export interface HttpExtensionRunnerClientOptions {
  /** Base URL of the runner service, for example `http://moira-extension-runner:9110`. */
  baseUrl: string;
  /** Extra margin over the call deadline before the transport itself gives up. */
  transportGraceMs?: number;
  /**
   * Deadline for the requests that carry no deadline of their own — asking what the runner provides
   * and whether it is ready. Without one, a runner that accepts the connection and says nothing
   * would hold up whoever is waiting: at startup that is the server process itself, and "the runner
   * is silent" must cost an installation a warning, not its start.
   */
  metadataTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface RunnerFailureBody {
  ok: false;
  kind: ExtensionFailureKind;
  message: string;
}

interface RunnerSuccessBody {
  ok: true;
  output: Record<string, unknown>;
  artifacts?: Array<{ name: string; content: string }>;
}

export class HttpExtensionRunnerClient implements IExtensionRunnerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpExtensionRunnerClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Declarations the runner currently provides, for filling the registry. */
  async listExtensions(): Promise<ExtensionManifest[]> {
    const response = await this.requestWithDeadline("/nodes");
    const body = (await response.json()) as {
      apiVersion?: string;
      extensions?: Array<Omit<ExtensionManifest, "apiVersion">>;
    };
    if (!Array.isArray(body.extensions)) return [];
    return body.extensions.map((extension) => ({
      ...(extension as Omit<ExtensionManifest, "apiVersion">),
      apiVersion: body.apiVersion ?? "",
    })) as ExtensionManifest[];
  }

  async health(): Promise<{ ready: boolean; body: unknown }> {
    const response = await this.requestWithDeadline("/health");
    const body = await response.json();
    return { ready: response.ok, body };
  }

  async invoke(request: ExtensionInvocationRequest): Promise<ExtensionInvocationResult> {
    // The transport waits a little longer than the call itself: the service is the one that owns
    // the deadline and kills the handler, and its typed timeout answer is more useful than a
    // transport abort that cannot say what happened on the other side.
    const grace = this.options.transportGraceMs ?? 5_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs + grace);

    let response: Response;
    try {
      response = await this.request("/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      throw new ExtensionInvocationError(
        aborted ? "timeout" : "runner-unavailable",
        aborted
          ? `the runner did not answer within ${request.timeoutMs + grace} ms`
          : `the extension runner could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new ExtensionInvocationError(
        "runner-unavailable",
        `the extension runner answered with HTTP ${response.status}`,
      );
    }

    const body = (await response.json()) as RunnerSuccessBody | RunnerFailureBody;
    if (body.ok) {
      const success = body as RunnerSuccessBody;
      return success.artifacts?.length
        ? { output: success.output, artifacts: success.artifacts }
        : { output: success.output };
    }

    // Read through an explicit type rather than relying on narrowing: this file is also compiled by
    // the frontend project, whose compiler options narrow the union less eagerly.
    const failure = body as RunnerFailureBody;
    throw new ExtensionInvocationError(failure.kind, failure.message);
  }

  /** A GET with its own deadline, so a silent runner fails instead of waiting indefinitely. */
  private async requestWithDeadline(pathname: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.metadataTimeoutMs ?? 5_000);
    try {
      return await this.request(pathname, { method: "GET", signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ExtensionInvocationError(
          "runner-unavailable",
          `the extension runner did not answer ${pathname} within ${this.options.metadataTimeoutMs ?? 5_000} ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    const url = new URL(pathname, this.options.baseUrl).toString();
    return this.fetchImpl(url, init);
  }
}
