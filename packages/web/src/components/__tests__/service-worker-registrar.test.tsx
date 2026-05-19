import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { ServiceWorkerRegistrar } from "@/components/service-worker-registrar";

describe("<ServiceWorkerRegistrar />", () => {
  const registerSpy = vi.fn(() => Promise.resolve({} as ServiceWorkerRegistration));
  const originalServiceWorker = (
    navigator as Navigator & { serviceWorker?: ServiceWorkerContainer }
  ).serviceWorker;

  beforeEach(() => {
    registerSpy.mockClear();
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerSpy },
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalServiceWorker) {
      Object.defineProperty(navigator, "serviceWorker", {
        value: originalServiceWorker,
        configurable: true,
      });
    } else {
      // @ts-expect-error - restore by deletion
      delete (navigator as Navigator & { serviceWorker?: unknown }).serviceWorker;
    }
    vi.unstubAllEnvs();
  });

  it("registers /sw.js in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    render(<ServiceWorkerRegistrar />);
    expect(registerSpy).toHaveBeenCalledWith("/sw.js");
  });

  it("does NOT register in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    render(<ServiceWorkerRegistrar />);
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it("renders nothing", () => {
    vi.stubEnv("NODE_ENV", "production");
    const { container } = render(<ServiceWorkerRegistrar />);
    expect(container.firstChild).toBeNull();
  });
});
