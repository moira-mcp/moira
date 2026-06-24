/**
 * Transient connection-error resilience for HTTP test suites.
 *
 * The api / mcp-tools / e2e suites run several Jest workers in parallel against ONE local
 * Docker container. Under that load a connection attempt occasionally drops before the
 * server accepts it, surfacing as `TypeError: fetch failed` (a connection-establishment
 * error — not an HTTP response, not an assertion). That is environmental flake, not a
 * product or test-logic bug.
 *
 * This setup wraps the global `fetch` to retry ONCE, and ONLY when fetch THROWS a transient
 * connection error. HTTP responses (including 4xx/5xx) are returned untouched and all
 * non-transient errors propagate, so genuine failures still surface — this hardens the
 * test client, it does not mask product behavior.
 */

const realFetch = globalThis.fetch;

if (typeof realFetch === "function" && !globalThis.__FETCH_RETRY_WRAPPED__) {
  globalThis.__FETCH_RETRY_WRAPPED__ = true;

  const isTransientConnectionError = (err) => {
    if (!err) return false;
    const message = String(err.message || err);
    const causeCode = err.cause && err.cause.code ? String(err.cause.code) : "";
    const transientPattern = /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|socket hang up|network socket disconnected|other side closed/i;
    return (
      (err instanceof TypeError && /fetch failed/i.test(message)) ||
      transientPattern.test(message) ||
      transientPattern.test(causeCode)
    );
  };

  globalThis.fetch = async (...args) => {
    try {
      return await realFetch(...args);
    } catch (err) {
      if (!isTransientConnectionError(err)) throw err;
      // One short backoff + single retry for a transient connection drop.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return await realFetch(...args);
    }
  };
}
