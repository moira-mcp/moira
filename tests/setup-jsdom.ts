/**
 * JSDOM Setup - Browser Environment Polyfills
 * Provides TextEncoder/TextDecoder and other browser APIs for jsdom tests
 *
 * This file is loaded for ALL unit tests, so we must check for browser environment
 * before applying browser-specific polyfills.
 */

import { TextEncoder, TextDecoder } from "util";
import { setImmediate, clearImmediate } from "timers";
import { deserialize, serialize } from "v8";
import {
  default as fetchPolyfill,
  Headers as FetchHeaders,
  Request as FetchRequest,
  Response as FetchResponse,
} from "node-fetch";

// Always polyfill TextEncoder/TextDecoder (needed by jose in both environments)
if (typeof global.TextEncoder === "undefined") {
  global.TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === "undefined") {
  global.TextDecoder = TextDecoder as typeof global.TextDecoder;
}

// Always polyfill setImmediate/clearImmediate (needed by some libs)
if (typeof global.setImmediate === "undefined") {
  global.setImmediate = setImmediate;
}
if (typeof global.clearImmediate === "undefined") {
  global.clearImmediate = clearImmediate;
}
// jsdom's window lacks structuredClone, which every supported browser has and the engine's
// authoring functions use; the V8 serializer copies the same values.
if (typeof global.structuredClone === "undefined") {
  global.structuredClone = (<T>(value: T): T =>
    deserialize(serialize(value)) as T) as typeof global.structuredClone;
}
if (typeof global.Headers === "undefined") {
  global.Headers = FetchHeaders as unknown as typeof global.Headers;
}
if (typeof global.Request === "undefined") {
  global.Request = FetchRequest as unknown as typeof global.Request;
}
if (typeof global.Response === "undefined") {
  global.Response = FetchResponse as unknown as typeof global.Response;
}
if (typeof global.fetch === "undefined") {
  global.fetch = fetchPolyfill as unknown as typeof global.fetch;
}

// Browser-specific polyfills - only apply in jsdom environment
if (typeof window !== "undefined") {
  // Mock window.matchMedia for components that use it
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }),
  });
}

// Mock ResizeObserver (may be needed in node environment for SSR tests)
if (typeof global.ResizeObserver === "undefined") {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Radix Select uses IntersectionObserver while measuring popup content.
if (typeof global.IntersectionObserver === "undefined") {
  global.IntersectionObserver = class IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    disconnect() {}
    observe() {}
    unobserve() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  };
}
