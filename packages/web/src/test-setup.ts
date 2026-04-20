import "@testing-library/jest-dom";
import { vi } from "vitest";

// Ensure consistent date/time behavior across all test environments
process.env.TZ = "UTC";

// In production, `after()` from next/server defers a callback until after
// the response is sent. In unit tests we have no real request lifecycle, so
// we run the callback immediately. This keeps existing audit-log assertions
// (which check appendAuditLog was called synchronously after the route
// handler returned) working unchanged after routes migrate from
// `appendAuditLog(...).catch(()=>{})` to `after(() => appendAuditLog(...))`.
//
// Exposed as a vi.fn() so tests can also assert that a route did schedule
// work via after(). vi.clearAllMocks() in test-level beforeEach hooks will
// reset its call count between tests.
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: vi.fn((fn: () => void | Promise<void>) => {
      // Run the deferred work synchronously so tests see its side effects.
      // Errors are caught here to mirror Next.js's production behavior:
      // after() callbacks that throw are routed to the framework error
      // handler, they do NOT crash the request or propagate as unhandled
      // rejections.
      try {
        const result = fn();
        if (result instanceof Promise) {
          result.catch(() => {});
        }
      } catch {
        // Swallowed — matches Next's after() error handling.
      }
    }),
  };
});

// Radix UI Checkbox uses ResizeObserver which is not available in jsdom
if (typeof window !== "undefined") {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  // Radix UI Select uses pointer capture APIs not available in jsdom
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  }
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = vi.fn();
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  }
}

// Only set up browser globals when running in jsdom environment
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
