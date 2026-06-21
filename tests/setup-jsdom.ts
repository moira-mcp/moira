/**
 * JSDOM Setup - Browser Environment Polyfills
 * Provides TextEncoder/TextDecoder and other browser APIs for jsdom tests
 *
 * This file is loaded for ALL unit tests, so we must check for browser environment
 * before applying browser-specific polyfills.
 */

import { TextEncoder, TextDecoder } from "util";
import { setImmediate, clearImmediate } from "timers";

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
