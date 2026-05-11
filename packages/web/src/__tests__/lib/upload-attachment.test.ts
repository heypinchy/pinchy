import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiError } from "@/lib/api-client";

// ---------------------------------------------------------------------------
// XHR mock infrastructure
// ---------------------------------------------------------------------------

type XHREventHandler = ((this: XMLHttpRequest, ev: ProgressEvent) => void) | null;

interface MockXHRInstance {
  open: ReturnType<typeof vi.fn>;
  setRequestHeader: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  // Writable event handlers assigned by the implementation
  onload: XHREventHandler;
  onerror: XHREventHandler;
  upload: {
    onprogress: ((this: XMLHttpRequestUpload, ev: ProgressEvent) => void) | null;
  };
  // Properties set by the test harness to simulate a response
  status: number;
  responseText: string;
  // Helper: trigger upload progress
  simulateProgress: (loaded: number, total: number) => void;
  // Helper: complete the request successfully
  simulateLoad: () => void;
  // Helper: trigger a network error
  simulateError: () => void;
}

/**
 * Build a mock XHR class constructor whose instances expose test helpers.
 * We return both the constructor (to stub XMLHttpRequest) and the singleton
 * instance so individual tests can inspect calls and trigger events.
 */
function createMockXHRClass(overrides?: Partial<Pick<MockXHRInstance, "status" | "responseText">>) {
  // We use a plain object for the instance and wire it inside the constructor.
  const instance: MockXHRInstance = {
    open: vi.fn(),
    setRequestHeader: vi.fn(),
    send: vi.fn(),
    onload: null,
    onerror: null,
    upload: { onprogress: null },
    status: overrides?.status ?? 201,
    responseText:
      overrides?.responseText ??
      JSON.stringify({
        id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        filename: "test.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      }),
    simulateProgress(loaded: number, total: number) {
      instance.upload.onprogress?.call(
        {} as XMLHttpRequestUpload,
        { loaded, total, lengthComputable: true } as ProgressEvent
      );
    },
    simulateLoad() {
      instance.onload?.call({} as XMLHttpRequest, {} as ProgressEvent);
    },
    simulateError() {
      instance.onerror?.call({} as XMLHttpRequest, {} as ProgressEvent);
    },
  };

  // The constructor must be a real `function` (not arrow) so that `new` works.
  // Returning an object from a constructor causes `new` to return that object
  // instead of `this`, giving us a single shared reference that both the test
  // (via `instance`) and the implementation (via `new XMLHttpRequest()`) hold.
  function MockXHRClass() {
    return instance;
  }

  return { MockXHRClass: MockXHRClass as unknown as new () => MockXHRInstance, instance };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("uploadAttachment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to the correct URL with the x-pinchy-draft-id header and file in FormData", async () => {
    const { MockXHRClass, instance: xhr } = createMockXHRClass();
    vi.stubGlobal("XMLHttpRequest", MockXHRClass);

    const { uploadAttachment } = await import("@/lib/upload-attachment");

    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const promise = uploadAttachment("agent-abc", "draft-id-123", file);

    // Verify open was called with POST and correct URL
    expect(xhr.open).toHaveBeenCalledWith("POST", "/api/agents/agent-abc/uploads");

    // Verify x-pinchy-draft-id header was set
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("x-pinchy-draft-id", "draft-id-123");

    // Verify send was called with a FormData containing the file
    expect(xhr.send).toHaveBeenCalledOnce();
    const formData = xhr.send.mock.calls[0][0] as FormData;
    expect(formData).toBeInstanceOf(FormData);
    expect(formData.get("file")).toBe(file);

    xhr.simulateLoad();
    await promise;
  });

  it("calls onProgress with percent values during upload", async () => {
    const { MockXHRClass, instance: xhr } = createMockXHRClass();
    vi.stubGlobal("XMLHttpRequest", MockXHRClass);

    const { uploadAttachment } = await import("@/lib/upload-attachment");

    const file = new File(["data"], "data.bin", { type: "application/octet-stream" });
    const progressValues: number[] = [];
    const promise = uploadAttachment("agent-1", "draft-1", file, (pct) => {
      progressValues.push(pct);
    });

    xhr.simulateProgress(25, 100);
    xhr.simulateProgress(50, 100);
    xhr.simulateProgress(100, 100);
    xhr.simulateLoad();
    await promise;

    expect(progressValues).toEqual([25, 50, 100]);
  });

  it("returns a parsed UploadResponse on 201", async () => {
    const expectedResponse = {
      id: "7f3c1a2b-4d5e-4f6a-8b9c-0d1e2f3a4b5c",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 2048,
    };
    const { MockXHRClass, instance: xhr } = createMockXHRClass({
      status: 201,
      responseText: JSON.stringify(expectedResponse),
    });
    vi.stubGlobal("XMLHttpRequest", MockXHRClass);

    const { uploadAttachment } = await import("@/lib/upload-attachment");

    const file = new File(["img"], "photo.jpg", { type: "image/jpeg" });
    const promise = uploadAttachment("agent-2", "draft-2", file);

    xhr.simulateLoad();
    const result = await promise;

    expect(result).toEqual(expectedResponse);
  });

  it("throws ApiError on a 400 non-2xx response", async () => {
    const { MockXHRClass, instance: xhr } = createMockXHRClass({
      status: 400,
      responseText: JSON.stringify({ error: "Bad Request" }),
    });
    vi.stubGlobal("XMLHttpRequest", MockXHRClass);

    const { uploadAttachment } = await import("@/lib/upload-attachment");

    const file = new File(["x"], "x.txt", { type: "text/plain" });
    const promise = uploadAttachment("agent-3", "draft-3", file);

    xhr.simulateLoad();

    await expect(promise).rejects.toThrow(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 400 });
  });

  it("throws ApiError on a 500 non-2xx response", async () => {
    const { MockXHRClass, instance: xhr } = createMockXHRClass({
      status: 500,
      responseText: JSON.stringify({ error: "Internal Server Error" }),
    });
    vi.stubGlobal("XMLHttpRequest", MockXHRClass);

    const { uploadAttachment } = await import("@/lib/upload-attachment");

    const file = new File(["x"], "x.txt", { type: "text/plain" });
    const promise = uploadAttachment("agent-4", "draft-4", file);

    xhr.simulateLoad();

    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 500 });
  });

  it("throws ApiError with a friendly fallback message when error body has no 'error' field", async () => {
    const { MockXHRClass, instance: xhr } = createMockXHRClass({
      status: 422,
      responseText: "{}",
    });
    vi.stubGlobal("XMLHttpRequest", MockXHRClass);

    const { uploadAttachment } = await import("@/lib/upload-attachment");

    const file = new File(["x"], "x.txt", { type: "text/plain" });
    const promise = uploadAttachment("agent-5", "draft-5", file);

    xhr.simulateLoad();

    await expect(promise).rejects.toMatchObject({
      status: 422,
      message: "Something went wrong. Please try again.",
    });
  });

  it("throws ApiError on a network error (onerror fires)", async () => {
    const { MockXHRClass, instance: xhr } = createMockXHRClass();
    vi.stubGlobal("XMLHttpRequest", MockXHRClass);

    const { uploadAttachment } = await import("@/lib/upload-attachment");

    const file = new File(["x"], "x.txt", { type: "text/plain" });
    const promise = uploadAttachment("agent-6", "draft-6", file);

    xhr.simulateError();

    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 0 });
  });
});
