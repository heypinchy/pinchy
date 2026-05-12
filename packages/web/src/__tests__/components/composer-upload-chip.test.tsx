import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  PendingUploadsContext,
  AddPendingUploadContext,
  RemovePendingUploadContext,
  RetryPendingUploadContext,
} from "@/components/chat";
import { PendingUploadChips } from "@/components/assistant-ui/thread";
import type { PendingUpload } from "@/hooks/use-ws-runtime";

function renderWithContexts(
  uploads: PendingUpload[],
  {
    onRemove = vi.fn(),
    onRetry = vi.fn(),
  }: {
    onRemove?: (localId: string) => void;
    onRetry?: (localId: string) => void;
  } = {}
) {
  return render(
    <PendingUploadsContext.Provider value={uploads}>
      <RemovePendingUploadContext.Provider value={onRemove}>
        <RetryPendingUploadContext.Provider value={onRetry}>
          <AddPendingUploadContext.Provider value={() => {}}>
            <PendingUploadChips />
          </AddPendingUploadContext.Provider>
        </RetryPendingUploadContext.Provider>
      </RemovePendingUploadContext.Provider>
    </PendingUploadsContext.Provider>
  );
}

describe("PendingUploadChips", () => {
  it("renders nothing when there are no pending uploads", () => {
    const { container } = renderWithContexts([]);
    expect(container.firstChild).toBeNull();
  });

  it("shows spinner during uploading state", () => {
    const upload: PendingUpload = {
      localId: "abc",
      file: new File(["data"], "photo.png", { type: "image/png" }),
      objectUrl: "blob:http://localhost/abc",
      state: "uploading",
      progress: 42,
    };
    renderWithContexts([upload]);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("shows progress value during uploading state", () => {
    const upload: PendingUpload = {
      localId: "abc",
      file: new File(["data"], "photo.png", { type: "image/png" }),
      objectUrl: "blob:http://localhost/abc",
      state: "uploading",
      progress: 65,
    };
    renderWithContexts([upload]);
    const progressBar = screen.getByRole("progressbar");
    expect(progressBar).toHaveAttribute("aria-valuenow", "65");
  });

  it("shows objectUrl as image src during uploading state for image files", () => {
    const upload: PendingUpload = {
      localId: "abc",
      file: new File(["data"], "photo.png", { type: "image/png" }),
      objectUrl: "blob:http://localhost/abc",
      state: "uploading",
      progress: 30,
    };
    renderWithContexts([upload]);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "blob:http://localhost/abc");
  });

  it("keeps the local objectUrl as image src when state flips to ready", () => {
    // The /api/agents/.../uploads/<filename> URL would 404 here — the file
    // sits in .staging/<uploadId>/ until the user actually sends. The chip
    // must therefore keep using the in-memory blob URL throughout its
    // entire lifetime (the pendingUploads entry is cleared on send anyway).
    const upload: PendingUpload = {
      localId: "abc",
      file: new File(["data"], "photo.png", { type: "image/png" }),
      objectUrl: "blob:http://localhost/abc",
      state: "ready",
      progress: 100,
      uploadId: "upload-1",
    };
    renderWithContexts([upload]);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "blob:http://localhost/abc");
  });

  it("shows filename in chip when in ready state", () => {
    const upload: PendingUpload = {
      localId: "abc",
      file: new File(["data"], "document.pdf", { type: "application/pdf" }),
      objectUrl: "blob:http://localhost/abc",
      state: "ready",
      progress: 100,
      uploadId: "upload-1",
    };
    renderWithContexts([upload]);
    expect(screen.getByText("document.pdf")).toBeInTheDocument();
  });

  it("shows error message and retry button when state is failed", () => {
    const upload: PendingUpload = {
      localId: "abc",
      file: new File(["data"], "photo.png", { type: "image/png" }),
      objectUrl: "blob:http://localhost/abc",
      state: "failed",
      progress: 0,
      error: "Upload failed: network error",
    };
    renderWithContexts([upload]);
    expect(screen.getByText("Upload failed: network error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("calls removePendingUpload when remove button is clicked", () => {
    const onRemove = vi.fn();
    const upload: PendingUpload = {
      localId: "abc",
      file: new File(["data"], "photo.png", { type: "image/png" }),
      objectUrl: "blob:http://localhost/abc",
      state: "uploading",
      progress: 50,
    };
    renderWithContexts([upload], { onRemove });
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(onRemove).toHaveBeenCalledWith("abc");
  });

  it("calls retryPendingUpload when retry button is clicked", () => {
    const onRetry = vi.fn();
    const upload: PendingUpload = {
      localId: "abc",
      file: new File(["data"], "photo.png", { type: "image/png" }),
      objectUrl: "blob:http://localhost/abc",
      state: "failed",
      progress: 0,
      error: "Upload failed",
    };
    renderWithContexts([upload], { onRetry });
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledWith("abc");
  });

  it("renders multiple chips for multiple uploads", () => {
    const uploads: PendingUpload[] = [
      {
        localId: "a",
        file: new File(["data"], "file1.png", { type: "image/png" }),
        objectUrl: "blob:http://localhost/a",
        state: "uploading",
        progress: 20,
      },
      {
        localId: "b",
        file: new File(["data"], "file2.pdf", { type: "application/pdf" }),
        objectUrl: "blob:http://localhost/b",
        state: "failed",
        progress: 0,
        error: "Failed",
      },
    ];
    renderWithContexts(uploads);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});
