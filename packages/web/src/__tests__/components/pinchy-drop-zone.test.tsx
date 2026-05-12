import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AddPendingUploadContext } from "@/components/chat";
import { PinchyDropZone } from "@/components/assistant-ui/pinchy-drop-zone";

function renderWithContext(addPendingUpload: (file: File) => void) {
  return render(
    <AddPendingUploadContext.Provider value={addPendingUpload}>
      <PinchyDropZone>
        <div data-testid="drop-child">child</div>
      </PinchyDropZone>
    </AddPendingUploadContext.Provider>
  );
}

function makeDropEvent(files: File[]) {
  return {
    dataTransfer: {
      files,
      items: files.map((f) => ({ kind: "file", type: f.type })),
      types: ["Files"],
    },
  };
}

describe("PinchyDropZone", () => {
  it("renders its children", () => {
    renderWithContext(vi.fn());
    expect(screen.getByTestId("drop-child")).toBeInTheDocument();
  });

  it("calls addPendingUpload for each dropped file", () => {
    const addPendingUpload = vi.fn();
    renderWithContext(addPendingUpload);
    const dropZone = screen.getByTestId("pinchy-drop-zone");

    const f1 = new File(["a"], "doc.pdf", { type: "application/pdf" });
    const f2 = new File(["b"], "photo.png", { type: "image/png" });
    fireEvent.drop(dropZone, makeDropEvent([f1, f2]));

    expect(addPendingUpload).toHaveBeenCalledTimes(2);
    expect(addPendingUpload).toHaveBeenNthCalledWith(1, f1);
    expect(addPendingUpload).toHaveBeenNthCalledWith(2, f2);
  });

  it("ignores drops that contain no files", () => {
    const addPendingUpload = vi.fn();
    renderWithContext(addPendingUpload);
    const dropZone = screen.getByTestId("pinchy-drop-zone");

    fireEvent.drop(dropZone, { dataTransfer: { files: [], items: [], types: [] } });

    expect(addPendingUpload).not.toHaveBeenCalled();
  });

  it("prevents default on dragover so the browser does not navigate to dropped files", () => {
    renderWithContext(vi.fn());
    const dropZone = screen.getByTestId("pinchy-drop-zone");
    const event = new Event("dragover", { bubbles: true, cancelable: true });
    // dispatchEvent returns false if any handler called preventDefault.
    const wasPrevented = !dropZone.dispatchEvent(event);
    expect(wasPrevented).toBe(true);
  });

  it("applies a 'dragging' data attribute while dragover is active", () => {
    renderWithContext(vi.fn());
    const dropZone = screen.getByTestId("pinchy-drop-zone");

    fireEvent.dragEnter(dropZone, {
      dataTransfer: { types: ["Files"], items: [{ kind: "file" }] },
    });
    expect(dropZone).toHaveAttribute("data-dragging", "true");

    fireEvent.dragLeave(dropZone, { dataTransfer: { types: ["Files"], items: [] } });
    expect(dropZone.getAttribute("data-dragging")).not.toBe("true");
  });
});
