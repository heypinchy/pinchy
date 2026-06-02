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
  abort: ReturnType<typeof vi.fn>;
  // Writable event handlers assigned by the implementation
  onload: XHREventHandler;
  onerror: XHREventHandler;
  ontimeout: (() => void) | null;
  onabort: (() => void) | null;
  upload: {
    onprogress: ((this: XMLHttpRequestUpload, ev: ProgressEvent) => void) | null;
  };
  // Properties set by the test harness to simulate a response
  status: number;
  responseText: string;
  timeout: number;
  // Helper: trigger upload progress
  simulateProgress: (loaded: number, total: number) => void;
  // Helper: complete the request successfully
  simulateLoad: () => void;
  // Helper: trigger a network error
  simulateError: () => void;
  // Helper: trigger a timeout
  simulateTimeout: () => void;
  // Helper: trigger an abort
  simulateAbort: () => void;
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
    abort: vi.fn(() => {
      // Production XHR.abort() fires onabort synchronously; mirror that here.
      instance.onabort?.();
    }),
    onload: null,
    onerror: null,
    ontimeout: null,
    onabort: null,
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
    timeout: 0,
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
    simulateTimeout() {
      instance.ontimeout?.();
    },
    simulateAbort() {
      instance.onabort?.();
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs to the correct URL with the x-pinchy-draft-id header and file in FormData", async () => {
    const { MockXHRClass, instance: xhr } = createMockXHRClass();
    vi.stubGlobal("XMLHttpRequest", MockXHRClass);

    const { uploadAttachment } = await import("@/lib/upload-attachment");

    const draftId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const promise = uploadAttachment("agent-abc", draftId, file);

    // Verify open was called with POST and correct URL
    expect(xhr.open).toHaveBeenCalledWith("POST", "/api/agents/agent-abc/uploads");

    // Verify x-pinchy-draft-id header was set
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("x-pinchy-draft-id", draftId);

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
    const promise = uploadAttachment(
      "agent-1",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      file,
      (pct) => {
        progressValues.push(pct);
      }
    );

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
    const promise = uploadAttachment("agent-2", "3fa85f64-5717-4562-b3fc-2c963f66afa6", file);

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
    const promise = uploadAttachment("agent-3", "3fa85f64-5717-4562-b3fc-2c963f66afa6", file);

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
    const promise = uploadAttachment("agent-4", "3fa85f64-5717-4562-b3fc-2c963f66afa6", file);

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
    const promise = uploadAttachment("agent-5", "3fa85f64-5717-4562-b3fc-2c963f66afa6", file);

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
    const promise = uploadAttachment("agent-6", "3fa85f64-5717-4562-b3fc-2c963f66afa6", file);

    xhr.simulateError();

    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 0 });
  });

  it("throws ApiError(0, 'Invalid draft ID') when draftId is not a UUID", async () => {
    const { uploadAttachment } = await import("@/lib/upload-attachment");

    const file = new File(["x"], "x.txt", { type: "text/plain" });

    await expect(uploadAttachment("agent-7", "not-a-uuid", file)).rejects.toMatchObject({
      status: 0,
      message: "Invalid draft ID",
    });
  });

  it("rejects with ApiError(0, 'Upload timed out. Please try again.') when ontimeout fires", async () => {
    const { MockXHRClass, instance: xhr } = createMockXHRClass();
    vi.stubGlobal("XMLHttpRequest", MockXHRClass);

    const { uploadAttachment } = await import("@/lib/upload-attachment");

    const file = new File(["x"], "x.txt", { type: "text/plain" });
    const promise = uploadAttachment("agent-8", "3fa85f64-5717-4562-b3fc-2c963f66afa6", file);

    xhr.simulateTimeout();

    await expect(promise).rejects.toMatchObject({
      status: 0,
      message: "Upload timed out. Please try again.",
    });
  });

  it("calls xhr.abort() when the AbortSignal fires after send", async () => {
    const { MockXHRClass, instance: xhr } = createMockXHRClass();
    vi.stubGlobal("XMLHttpRequest", MockXHRClass);

    const { uploadAttachment } = await import("@/lib/upload-attachment");

    const controller = new AbortController();
    const file = new File(["x"], "x.txt", { type: "text/plain" });
    const promise = uploadAttachment(
      "agent-abort-1",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      file,
      undefined,
      controller.signal
    );

    // Caller decides mid-upload that they want to cancel — the upstream
    // bandwidth and the staging row are both wasted otherwise.
    controller.abort();

    expect(xhr.abort).toHaveBeenCalledOnce();
    await expect(promise).rejects.toMatchObject({
      status: 0,
      message: "Upload cancelled.",
    });
  });

  it("rejects synchronously when the AbortSignal is already aborted at call time", async () => {
    const { MockXHRClass } = createMockXHRClass();
    vi.stubGlobal("XMLHttpRequest", MockXHRClass);

    const { uploadAttachment } = await import("@/lib/upload-attachment");

    const controller = new AbortController();
    controller.abort();

    const file = new File(["x"], "x.txt", { type: "text/plain" });
    await expect(
      uploadAttachment(
        "agent-abort-2",
        "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        file,
        undefined,
        controller.signal
      )
    ).rejects.toMatchObject({
      status: 0,
      message: "Upload cancelled.",
    });
  });

  it("rejects with ApiError(0, 'Upload cancelled.') when onabort fires", async () => {
    const { MockXHRClass, instance: xhr } = createMockXHRClass();
    vi.stubGlobal("XMLHttpRequest", MockXHRClass);

    const { uploadAttachment } = await import("@/lib/upload-attachment");

    const file = new File(["x"], "x.txt", { type: "text/plain" });
    const promise = uploadAttachment("agent-9", "3fa85f64-5717-4562-b3fc-2c963f66afa6", file);

    xhr.simulateAbort();

    await expect(promise).rejects.toMatchObject({
      status: 0,
      message: "Upload cancelled.",
    });
  });
});
