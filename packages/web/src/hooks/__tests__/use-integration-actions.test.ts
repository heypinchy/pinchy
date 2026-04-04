import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIntegrationActions } from "../use-integration-actions";

// Mock sonner
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("useIntegrationActions", () => {
  const mockOnChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("testConnection", () => {
    it("sets testing state during the call", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const { result } = renderHook(() => useIntegrationActions(mockOnChange));

      expect(result.current.testing).toBeNull();

      let promise: Promise<void>;
      act(() => {
        promise = result.current.testConnection("conn-1");
      });

      expect(result.current.testing).toBe("conn-1");

      await act(async () => {
        await promise!;
      });

      expect(result.current.testing).toBeNull();
    });

    it("shows success toast on successful test", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const { result } = renderHook(() => useIntegrationActions(mockOnChange));

      await act(async () => {
        await result.current.testConnection("conn-1");
      });

      expect(mockToastSuccess).toHaveBeenCalledWith("Connection successful");
    });

    it("shows error toast when test fails", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: false, error: "Auth failed" }),
      });

      const { result } = renderHook(() => useIntegrationActions(mockOnChange));

      await act(async () => {
        await result.current.testConnection("conn-1");
      });

      expect(mockToastError).toHaveBeenCalledWith("Auth failed");
    });

    it("shows error toast on network error", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const { result } = renderHook(() => useIntegrationActions(mockOnChange));

      await act(async () => {
        await result.current.testConnection("conn-1");
      });

      expect(mockToastError).toHaveBeenCalledWith("Failed to test connection");
    });
  });

  describe("syncSchema", () => {
    it("sets syncing state during the call", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const { result } = renderHook(() => useIntegrationActions(mockOnChange));

      let promise: Promise<void>;
      act(() => {
        promise = result.current.syncSchema("conn-1");
      });

      expect(result.current.syncing).toBe("conn-1");

      await act(async () => {
        await promise!;
      });

      expect(result.current.syncing).toBeNull();
    });

    it("calls onChange after successful sync", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const { result } = renderHook(() => useIntegrationActions(mockOnChange));

      await act(async () => {
        await result.current.syncSchema("conn-1");
      });

      expect(mockToastSuccess).toHaveBeenCalledWith("Schema synced successfully");
      expect(mockOnChange).toHaveBeenCalled();
    });

    it("shows error toast when sync fails", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: false, error: "Permission denied" }),
      });

      const { result } = renderHook(() => useIntegrationActions(mockOnChange));

      await act(async () => {
        await result.current.syncSchema("conn-1");
      });

      expect(mockToastError).toHaveBeenCalledWith("Permission denied");
      expect(mockOnChange).not.toHaveBeenCalled();
    });
  });

  describe("renameConnection", () => {
    it("calls PATCH with trimmed name", async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const { result } = renderHook(() => useIntegrationActions(mockOnChange));

      await act(async () => {
        await result.current.renameConnection("conn-1", "  New Name  ");
      });

      expect(mockFetch).toHaveBeenCalledWith("/api/integrations/conn-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name" }),
      });
      expect(mockToastSuccess).toHaveBeenCalledWith("Integration renamed");
      expect(mockOnChange).toHaveBeenCalled();
    });

    it("does nothing for empty name", async () => {
      const { result } = renderHook(() => useIntegrationActions(mockOnChange));

      await act(async () => {
        await result.current.renameConnection("conn-1", "   ");
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("shows error toast on failure", async () => {
      mockFetch.mockResolvedValue({ ok: false });

      const { result } = renderHook(() => useIntegrationActions(mockOnChange));

      await act(async () => {
        await result.current.renameConnection("conn-1", "New Name");
      });

      expect(mockToastError).toHaveBeenCalledWith("Failed to rename integration");
    });
  });

  describe("deleteConnection", () => {
    it("calls DELETE and triggers onChange", async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const { result } = renderHook(() => useIntegrationActions(mockOnChange));

      await act(async () => {
        await result.current.deleteConnection("conn-1");
      });

      expect(mockFetch).toHaveBeenCalledWith("/api/integrations/conn-1", { method: "DELETE" });
      expect(mockToastSuccess).toHaveBeenCalledWith("Integration deleted");
      expect(mockOnChange).toHaveBeenCalled();
    });

    it("shows error toast on failure", async () => {
      mockFetch.mockResolvedValue({ ok: false });

      const { result } = renderHook(() => useIntegrationActions(mockOnChange));

      await act(async () => {
        await result.current.deleteConnection("conn-1");
      });

      expect(mockToastError).toHaveBeenCalledWith("Failed to delete integration");
      expect(mockOnChange).not.toHaveBeenCalled();
    });
  });
});
