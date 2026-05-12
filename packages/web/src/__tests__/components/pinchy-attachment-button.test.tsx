import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AddPendingUploadContext } from "@/components/chat";
import { PinchyAttachmentButton } from "@/components/assistant-ui/pinchy-attachment-button";

function renderWithContext(addPendingUpload: (file: File) => void) {
  return render(
    <TooltipProvider>
      <AddPendingUploadContext.Provider value={addPendingUpload}>
        <PinchyAttachmentButton />
      </AddPendingUploadContext.Provider>
    </TooltipProvider>
  );
}

describe("PinchyAttachmentButton", () => {
  it("renders a clickable button labelled 'Add Attachment'", () => {
    renderWithContext(vi.fn());
    expect(screen.getByRole("button", { name: /add attachment/i })).toBeInTheDocument();
  });

  it("opens the hidden file input when the button is clicked", () => {
    renderWithContext(vi.fn());
    const input = screen.getByTestId("pinchy-attachment-input") as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: /add attachment/i }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("calls addPendingUpload with the picked file", () => {
    const addPendingUpload = vi.fn();
    renderWithContext(addPendingUpload);

    const input = screen.getByTestId("pinchy-attachment-input") as HTMLInputElement;
    const file = new File(["x"], "doc.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(addPendingUpload).toHaveBeenCalledTimes(1);
    expect(addPendingUpload).toHaveBeenCalledWith(file);
  });

  it("calls addPendingUpload for each picked file", () => {
    const addPendingUpload = vi.fn();
    renderWithContext(addPendingUpload);

    const input = screen.getByTestId("pinchy-attachment-input") as HTMLInputElement;
    const file1 = new File(["x"], "a.pdf", { type: "application/pdf" });
    const file2 = new File(["y"], "b.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file1, file2] } });

    expect(addPendingUpload).toHaveBeenCalledTimes(2);
    expect(addPendingUpload).toHaveBeenNthCalledWith(1, file1);
    expect(addPendingUpload).toHaveBeenNthCalledWith(2, file2);
  });

  it("resets the input value after change so picking the same file twice works", () => {
    const addPendingUpload = vi.fn();
    renderWithContext(addPendingUpload);

    const input = screen.getByTestId("pinchy-attachment-input") as HTMLInputElement;
    const file = new File(["x"], "a.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });
    // Browsers do not fire 'change' a second time when the same file is picked
    // unless the input value is cleared. We expect the component to clear it.
    expect(input.value).toBe("");
  });

  it("accepts only image and pdf MIME types in the file picker", () => {
    renderWithContext(vi.fn());
    const input = screen.getByTestId("pinchy-attachment-input") as HTMLInputElement;
    expect(input.accept).toContain("image/");
    expect(input.accept).toContain("application/pdf");
  });
});
