// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { jsonResponse } from "@/test-helpers/fetch";
import {
  fetchLicenseStatus,
  useLicenseStatus,
  LICENSE_STATUS_RETRY_DELAYS_MS,
  LICENSE_STATUS_TOAST_ID,
} from "@/hooks/use-license-status";
import type { LicenseInfo } from "@/lib/enterprise";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));

const enterpriseStatus: LicenseInfo = {
  enterprise: true,
  state: "paid",
  type: "paid",
  org: "Acme",
  expiresAt: null,
  paidUntil: null,
  daysRemaining: null,
  managedByEnv: false,
  maxUsers: 10,
  seatsUsed: 3,
  hasGatedConfig: false,
};

describe("fetchLicenseStatus", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());

  it("returns the status on a 200 with an enterprise flag", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(enterpriseStatus));
    await expect(fetchLicenseStatus()).resolves.toEqual(enterpriseStatus);
  });

  it("rejects on a non-OK response instead of answering community", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "Internal" }, { status: 500 }));
    await expect(fetchLicenseStatus()).rejects.toThrow();
  });

  it("rejects on a 401, whose body has no enterprise flag", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "Unauthorized" }, { status: 401 }));
    await expect(fetchLicenseStatus()).rejects.toThrow();
  });

  it("rejects a 200 whose body carries no boolean enterprise flag", async () => {
    // A proxy's HTML page or a renamed field must not read as `enterprise: false`.
    fetchSpy.mockResolvedValue(jsonResponse({ state: "active" }));
    await expect(fetchLicenseStatus()).rejects.toThrow(/enterprise/);
  });
});

describe("useLicenseStatus", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(global, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("stays unknown (null) after a failed fetch — never community", async () => {
    fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useLicenseStatus());
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(result.current.license).toBeNull();
  });

  it("retries after a failure and settles on the real answer", async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ error: "Bad gateway" }, { status: 502 }))
      .mockResolvedValue(jsonResponse(enterpriseStatus));

    const { result } = renderHook(() => useLicenseStatus());
    await act(async () => {});
    expect(result.current.license).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LICENSE_STATUS_RETRY_DELAYS_MS[0]);
    });
    expect(result.current.license).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LICENSE_STATUS_RETRY_DELAYS_MS[1]);
    });
    expect(result.current.license).toEqual(enterpriseStatus);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("keeps the last known status when a later refetch fails", async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(enterpriseStatus))
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const { result, rerender } = renderHook(({ k }) => useLicenseStatus({ refreshKey: k }), {
      initialProps: { k: 0 },
    });
    await act(async () => {});
    expect(result.current.license).toEqual(enterpriseStatus);

    rerender({ k: 1 });
    await act(async () => {});
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.current.license).toEqual(enterpriseStatus);
  });

  it("notifies once per failure streak and clears the toast on recovery", async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(jsonResponse(enterpriseStatus));

    renderHook(() => useLicenseStatus({ notifyOnFailure: true }));
    await act(async () => {});
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(expect.any(String), { id: LICENSE_STATUS_TOAST_ID });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LICENSE_STATUS_RETRY_DELAYS_MS[0]);
    });
    expect(toast.error).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LICENSE_STATUS_RETRY_DELAYS_MS[1]);
    });
    expect(toast.dismiss).toHaveBeenCalledWith(LICENSE_STATUS_TOAST_ID);
  });

  it("stays silent on failure unless asked to notify", async () => {
    fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));
    renderHook(() => useLicenseStatus());
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await act(async () => {});
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("stops retrying once unmounted", async () => {
    vi.useFakeTimers();
    fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));
    const { unmount } = renderHook(() => useLicenseStatus());
    await act(async () => {});
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the initial status without fetching, and refetch() loads a fresh one", async () => {
    const fresh = { ...enterpriseStatus, seatsUsed: 4 };
    fetchSpy.mockResolvedValue(jsonResponse(fresh));
    const { result } = renderHook(() => useLicenseStatus({ initial: enterpriseStatus }));
    await act(async () => {});
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.license).toEqual(enterpriseStatus);

    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.license).toEqual(fresh);
  });

  it("does not fetch while disabled", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(enterpriseStatus));
    renderHook(() => useLicenseStatus({ enabled: false }));
    await act(async () => {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
