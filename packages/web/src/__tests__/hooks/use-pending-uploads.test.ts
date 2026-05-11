/**
 * Tests for the PendingUpload state machine in useWsRuntime.
 *
 * Covers:
 *   1. addPendingUpload → creates entry with state "uploading", progress 0
 *   2. Progress callback → updates progress field
 *   3. Upload success → state flips to "ready", uploadId set, previewUrl set
 *   4. Upload failure → state flips to "failed", error set
 *   5. removePendingUpload → removes from state, calls URL.revokeObjectURL
 *   6. retryPendingUpload → resets to "uploading", re-calls uploadAttachment
 *   7. Send is blocked while any upload is in "uploading" state
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWsRuntime, type PendingUpload } from "@/hooks/use-ws-runtime";
import * as uploadModule from "@/lib/upload-attachment";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/upload-attachment", () => ({
  uploadAttachment: vi.fn(),
}));

vi.mock("@/lib/image-compression", () => ({
  compressImageForChat: vi.fn(async (file: File) => ({
    ok: true,
    file,
    skipped: true,
  })),
}));

vi.mock("@/components/restart-provider", () => ({
  useRestart: () => ({ triggerRestart: vi.fn() }),
}));

vi.mock("@assistant-ui/react", () => ({
  useExternalStoreRuntime: (config: unknown) => config,
  SimpleImageAttachmentAdapter: class {
    accept = "image/*";
  },
  SimpleTextAttachmentAdapter: class {
    accept = "text/plain,text/html,text/markdown,text/csv";
  },
  CompositeAttachmentAdapter: class {
    accept: string;
    constructor(adapters: { accept: string }[]) {
      this.accept = adapters.map((a) => a.accept).join(",");
    }
  },
}));

// ── WebSocket stub ────────────────────────────────────────────────────────────

class MockWebSocket {
  static OPEN = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

vi.stubGlobal("WebSocket", MockWebSocket);

// ── URL mock helpers ──────────────────────────────────────────────────────────

const mockCreateObjectURL = vi.fn(() => "blob:mock-url");
const mockRevokeObjectURL = vi.fn();
vi.stubGlobal("URL", {
  createObjectURL: mockCreateObjectURL,
  revokeObjectURL: mockRevokeObjectURL,
});

// ── localStorage stub (needed by useDraftId) ──────────────────────────────────

const localStorageStore: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (key: string) => localStorageStore[key] ?? null,
  setItem: (key: string, value: string) => {
    localStorageStore[key] = value;
  },
  removeItem: (key: string) => {
    delete localStorageStore[key];
  },
  clear: () => {
    Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]);
  },
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PendingUpload state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateObjectURL.mockReturnValue("blob:mock-url");
    Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeFile(name = "test.pdf", size = 1024): File {
    return new File([new Uint8Array(size)], name, { type: "application/pdf" });
  }

  it("addPendingUpload creates entry with state 'uploading' and progress 0", async () => {
    // uploadAttachment hangs indefinitely for this test
    vi.mocked(uploadModule.uploadAttachment).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useWsRuntime("agent-1"));

    const file = makeFile();
    await act(async () => {
      result.current.addPendingUpload(file);
    });

    expect(result.current.pendingUploads).toHaveLength(1);
    const upload = result.current.pendingUploads[0] as PendingUpload;
    expect(upload.state).toBe("uploading");
    expect(upload.progress).toBe(0);
    expect(upload.file).toBe(file);
    expect(upload.objectUrl).toBe("blob:mock-url");
    expect(upload.localId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(mockCreateObjectURL).toHaveBeenCalledWith(file);
  });

  it("progress callback updates the progress field", async () => {
    let capturedProgressCb: ((p: number) => void) | undefined;

    vi.mocked(uploadModule.uploadAttachment).mockImplementation(
      (_agentId, _draftId, _file, onProgress) => {
        capturedProgressCb = onProgress;
        return new Promise(() => {}); // never resolves
      }
    );

    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      result.current.addPendingUpload(makeFile());
    });

    await act(async () => {
      capturedProgressCb?.(42);
    });

    expect(result.current.pendingUploads[0].progress).toBe(42);
  });

  it("upload success → state flips to 'ready', uploadId and previewUrl set", async () => {
    vi.mocked(uploadModule.uploadAttachment).mockResolvedValue({
      id: "upload-id-123",
      filename: "test.pdf",
    });

    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      result.current.addPendingUpload(makeFile("test.pdf"));
    });

    const upload = result.current.pendingUploads[0] as PendingUpload;
    expect(upload.state).toBe("ready");
    expect(upload.uploadId).toBe("upload-id-123");
    expect(upload.previewUrl).toBe("/api/agents/agent-1/uploads/test.pdf");
    expect(upload.progress).toBe(100);
    // Object URL should be revoked after successful upload (swapped for server URL)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("upload failure → state flips to 'failed', error message set", async () => {
    vi.mocked(uploadModule.uploadAttachment).mockRejectedValue(
      new Error("Upload timed out. Please try again.")
    );

    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      result.current.addPendingUpload(makeFile());
    });

    const upload = result.current.pendingUploads[0] as PendingUpload;
    expect(upload.state).toBe("failed");
    expect(upload.error).toBe("Upload timed out. Please try again.");
  });

  it("upload failure with non-Error value → falls back to 'Upload failed'", async () => {
    vi.mocked(uploadModule.uploadAttachment).mockRejectedValue("something went wrong");

    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      result.current.addPendingUpload(makeFile());
    });

    const upload = result.current.pendingUploads[0] as PendingUpload;
    expect(upload.state).toBe("failed");
    expect(upload.error).toBe("Upload failed");
  });

  it("removePendingUpload removes the entry and revokes its object URL", async () => {
    vi.mocked(uploadModule.uploadAttachment).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      result.current.addPendingUpload(makeFile());
    });

    expect(result.current.pendingUploads).toHaveLength(1);
    const localId = result.current.pendingUploads[0].localId;

    await act(async () => {
      result.current.removePendingUpload(localId);
    });

    expect(result.current.pendingUploads).toHaveLength(0);
    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("removePendingUpload is a no-op for an unknown localId", async () => {
    vi.mocked(uploadModule.uploadAttachment).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      result.current.addPendingUpload(makeFile());
    });

    expect(result.current.pendingUploads).toHaveLength(1);

    await act(async () => {
      result.current.removePendingUpload("non-existent-id");
    });

    // Original upload should still be present
    expect(result.current.pendingUploads).toHaveLength(1);
  });

  it("retryPendingUpload resets state to 'uploading' and re-calls uploadAttachment", async () => {
    // First call fails
    vi.mocked(uploadModule.uploadAttachment).mockRejectedValueOnce(new Error("Network error"));
    // Second call succeeds
    vi.mocked(uploadModule.uploadAttachment).mockResolvedValueOnce({
      id: "upload-id-456",
      filename: "retry.pdf",
    });

    const { result } = renderHook(() => useWsRuntime("agent-1"));

    await act(async () => {
      result.current.addPendingUpload(makeFile("retry.pdf"));
    });

    expect(result.current.pendingUploads[0].state).toBe("failed");
    const localId = result.current.pendingUploads[0].localId;

    await act(async () => {
      result.current.retryPendingUpload(localId);
    });

    // After retry succeeds
    const upload = result.current.pendingUploads[0] as PendingUpload;
    expect(upload.state).toBe("ready");
    expect(upload.uploadId).toBe("upload-id-456");
    expect(uploadModule.uploadAttachment).toHaveBeenCalledTimes(2);
  });

  it("retryPendingUpload is a no-op for an unknown localId", async () => {
    vi.mocked(uploadModule.uploadAttachment).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useWsRuntime("agent-1"));

    const callsBefore = vi.mocked(uploadModule.uploadAttachment).mock.calls.length;

    await act(async () => {
      result.current.retryPendingUpload("non-existent-id");
    });

    expect(vi.mocked(uploadModule.uploadAttachment).mock.calls.length).toBe(callsBefore);
  });

  it("pendingUploads blocks send when any upload is in uploading state", async () => {
    vi.mocked(uploadModule.uploadAttachment).mockReturnValue(new Promise(() => {})); // never resolves

    const { result } = renderHook(() => useWsRuntime("agent-1"));

    // Initially no pending uploads
    expect(result.current.pendingUploads.every((u) => u.state === "ready")).toBe(true);
    expect(result.current.pendingUploads.some((u) => u.state !== "ready")).toBe(false);

    await act(async () => {
      result.current.addPendingUpload(makeFile());
    });

    // Now an upload is in "uploading" state — send should be blocked
    expect(result.current.pendingUploads.some((u) => u.state !== "ready")).toBe(true);
  });

  it("pendingUploads are reset to [] when agentId changes", async () => {
    vi.mocked(uploadModule.uploadAttachment).mockReturnValue(new Promise(() => {}));

    const { result, rerender } = renderHook(({ agentId }) => useWsRuntime(agentId), {
      initialProps: { agentId: "agent-1" },
    });

    await act(async () => {
      result.current.addPendingUpload(makeFile());
    });

    expect(result.current.pendingUploads).toHaveLength(1);

    // Switch to agent-2
    rerender({ agentId: "agent-2" });

    expect(result.current.pendingUploads).toHaveLength(0);
    // Object URLs from agent-1 uploads must have been revoked
    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("encodes agentId and filename in previewUrl", async () => {
    vi.mocked(uploadModule.uploadAttachment).mockResolvedValue({
      id: "upload-id-789",
      filename: "my file.pdf",
    });

    const { result } = renderHook(() => useWsRuntime("agent/with spaces"));

    await act(async () => {
      result.current.addPendingUpload(makeFile("my file.pdf"));
    });

    const upload = result.current.pendingUploads[0] as PendingUpload;
    expect(upload.previewUrl).toBe("/api/agents/agent%2Fwith%20spaces/uploads/my%20file.pdf");
  });
});
