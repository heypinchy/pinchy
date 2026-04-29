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

// Radix UI react-focus-scope@1.1.7 schedules a setTimeout(0) on unmount to
// restore focus. In jsdom 29.x the realm check inside dispatchEvent rejects the
// CustomEvent with "parameter 1 is not of type 'Event'" because the event was
// constructed after test cleanup. All real tests still pass — this swallows the
// stale cleanup noise so the test run exits cleanly.
if (typeof EventTarget !== "undefined") {
  const _origDispatchEvent = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event: Event) {
    try {
      return _origDispatchEvent.call(this, event);
    } catch (e) {
      if (e instanceof TypeError && String(e).includes("parameter 1 is not of type 'Event'")) {
        return false;
      }
      throw e;
    }
  };
}

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
