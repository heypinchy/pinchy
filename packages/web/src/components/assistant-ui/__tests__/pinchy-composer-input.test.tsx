// Regression guard for the clipboard-paste attachment path.
//
// Bug history: pasting a screenshot into the composer (Cmd+V or right-click →
// Paste) silently did nothing. `9fbb91e3c` shipped paste as a first-class
// feature ("add chat attachments (images, text files, clipboard paste)") on the
// back of `SimpleImageAttachmentAdapter`. `f50c72eb6` (PR #342) migrated
// attachments to the two-phase upload pipeline and dropped that adapter,
// because its base64 `image_url` frames are rejected server-side with
// PROTOCOL_OUTDATED. That commit re-wired the file picker
// (PinchyAttachmentButton) and drag & drop (PinchyDropZone) onto
// `addPendingUpload` — but not paste.
//
// Root cause: assistant-ui's `ComposerPrimitive.Input` has a built-in paste
// handler (`addAttachmentOnPaste`, default TRUE) that calls
// `composer.addAttachment(file)`. That lands in `CompositeAttachmentAdapter`,
// which after #342 holds only the code-text and .docx adapters. No adapter
// accepts `image/png`, so `add()` throws "No matching adapter found for file".
// The throw is swallowed by handlePaste's own try/catch and downgraded to a
// console.error — and since it calls `e.preventDefault()` first, the paste
// vanishes with no user-visible feedback.
//
// Why this test renders the REAL primitive (no assistant-ui mock, same reason
// as composer-ime-composition.test.tsx): the entire bug lives in the seam
// between our wiring and the dependency's built-in paste behavior. A mocked
// `ComposerPrimitive.Input` is a bare <textarea> with no built-in handler, so
// the double-handling this file pins could never regress there. Pinning it
// against the real dependency means a version bump that changes the
// `addAttachmentOnPaste` contract fails HERE.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { FC } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { AddPendingUploadContext } from "@/components/chat";
import { PinchyComposerInput } from "@/components/assistant-ui/pinchy-composer-input";

// A permissive attachment adapter standing in for the real adapter chain. It
// accepts everything, so if the built-in paste handler were still live it would
// dispatch here — letting `add` double as the probe for "paste leaked into the
// adapter chain". Its presence is also what makes the thread report
// `capabilities.attachments === true`, the precondition the built-in handler
// checks before doing anything at all.
function makeSpyAdapter() {
  return {
    accept: "*",
    add: vi.fn(async ({ file }: { file: File }) => ({
      id: file.name,
      type: "image" as const,
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action" as const, reason: "composer-send" as const },
    })),
    send: vi.fn(),
    remove: vi.fn(),
  };
}

const Harness: FC<{
  addPendingUpload: (file: File) => void;
  adapter: ReturnType<typeof makeSpyAdapter>;
}> = ({ addPendingUpload, adapter }) => {
  const runtime = useExternalStoreRuntime({
    messages: [] as ThreadMessageLike[],
    isRunning: false,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {},
    adapters: { attachments: adapter },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AddPendingUploadContext.Provider value={addPendingUpload}>
        <PinchyComposerInput aria-label="Message input" />
      </AddPendingUploadContext.Provider>
    </AssistantRuntimeProvider>
  );
};

function renderComposer() {
  const addPendingUpload = vi.fn();
  const adapter = makeSpyAdapter();
  render(<Harness addPendingUpload={addPendingUpload} adapter={adapter} />);
  return {
    addPendingUpload,
    adapter,
    textarea: screen.getByRole("textbox") as HTMLTextAreaElement,
  };
}

// Model a clipboard payload the way a browser delivers one. A screenshot paste
// carries the bitmap in `files`; a plain-text paste carries none.
function firePaste(textarea: HTMLTextAreaElement, files: File[]) {
  return fireEvent.paste(textarea, {
    clipboardData: { files, items: files.map((f) => ({ kind: "file", type: f.type })) },
  });
}

describe("PinchyComposerInput clipboard paste", () => {
  it("routes a pasted screenshot into the two-phase upload pipeline", () => {
    const { addPendingUpload, textarea } = renderComposer();
    const screenshot = new File(["png-bytes"], "screenshot.png", { type: "image/png" });

    firePaste(textarea, [screenshot]);

    // THE REGRESSION: this was 0 calls — the paste was swallowed by the
    // dependency's built-in handler and lost in a console.error.
    expect(addPendingUpload).toHaveBeenCalledTimes(1);
    expect(addPendingUpload).toHaveBeenCalledWith(screenshot);
  });

  it("does NOT route pasted files through the assistant-ui adapter chain", () => {
    const { adapter, textarea } = renderComposer();

    firePaste(textarea, [new File(["png-bytes"], "screenshot.png", { type: "image/png" })]);

    // The adapter chain is the path that emits base64 `image_url` frames the
    // server rejects with PROTOCOL_OUTDATED. Paste must bypass it entirely —
    // otherwise an attachment gets added twice (once per path) for any MIME the
    // chain happens to accept.
    expect(adapter.add).not.toHaveBeenCalled();
  });

  it("attaches every file of a multi-file paste", () => {
    const { addPendingUpload, textarea } = renderComposer();
    const png = new File(["a"], "shot.png", { type: "image/png" });
    const pdf = new File(["b"], "doc.pdf", { type: "application/pdf" });

    firePaste(textarea, [png, pdf]);

    expect(addPendingUpload).toHaveBeenCalledTimes(2);
    expect(addPendingUpload).toHaveBeenNthCalledWith(1, png);
    expect(addPendingUpload).toHaveBeenNthCalledWith(2, pdf);
  });

  it("leaves a plain-text paste to the browser", () => {
    const { addPendingUpload, textarea } = renderComposer();

    // `fireEvent` returns false once a handler called preventDefault. Text must
    // keep its default behavior, or pasting into the message box stops working.
    const notPrevented = firePaste(textarea, []);

    expect(addPendingUpload).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });
});
