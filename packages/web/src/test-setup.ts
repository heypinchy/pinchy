import { vi } from "vitest";

// Ensure consistent date/time behavior across all test environments
process.env.TZ = "UTC";

// Radix UI Checkbox uses ResizeObserver which is not available in jsdom
if (typeof window !== "undefined") {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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
