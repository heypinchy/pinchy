// Behavioural guard for the share → composer intake: the /share picker
// hands off to `/chat/<agentId>?keep&share=<id>` (see share-picker.tsx), and
// this hook is what actually reads that payload back out of the cache and
// feeds it into the composer — files via the same two-phase upload pipeline
// as a manual attachment pick, and any shared text/url as a text prefill
// (shared LINKS carry no file, so the prefill is their only path into the
// composer). It must run exactly once per share id and never crash the chat
// on a corrupted/expired cache entry, and it must strip only the `share`
// param off the URL afterwards — `?keep` has to survive, or the chat page's
// server-side redirect-to-most-recent-chat would kick back in on any
// subsequent navigation that re-hits the bare route.
import { render } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useShareIntake } from "../use-share-intake";

const { readSharedPayload, clearSharedPayload } = vi.hoisted(() => ({
  readSharedPayload: vi.fn(),
  clearSharedPayload: vi.fn(),
}));

vi.mock("@/lib/share-target/share-cache", () => ({
  readSharedPayload,
  clearSharedPayload,
}));

const replace = vi.fn();
const mockSearchParams = { current: new URLSearchParams("keep=&share=abc") };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/chat/a1",
  useSearchParams: () => mockSearchParams.current,
}));

function Harness({
  addPendingUpload,
  setComposerText,
}: {
  addPendingUpload: (file: File) => void;
  setComposerText?: (text: string) => void;
}) {
  useShareIntake({ addPendingUpload, setComposerText });
  return null;
}

describe("useShareIntake", () => {
  beforeEach(() => {
    mockSearchParams.current = new URLSearchParams("keep=&share=abc");
    readSharedPayload.mockReset();
    clearSharedPayload.mockReset();
    replace.mockReset();
  });

  it("attaches every shared file and prefills the composer with text + url, then clears the cache", async () => {
    const file1 = new File(["a"], "one.pdf", { type: "application/pdf" });
    const file2 = new File(["b"], "two.pdf", { type: "application/pdf" });
    readSharedPayload.mockResolvedValue({
      files: [file1, file2],
      title: "ignored",
      text: "please book this",
      url: "https://example.com/thing",
    });

    const addPendingUpload = vi.fn();
    const setComposerText = vi.fn();

    render(<Harness addPendingUpload={addPendingUpload} setComposerText={setComposerText} />);

    await vi.waitFor(() => {
      expect(clearSharedPayload).toHaveBeenCalledWith("abc");
    });

    expect(addPendingUpload).toHaveBeenCalledTimes(2);
    expect(addPendingUpload).toHaveBeenNthCalledWith(1, file1);
    expect(addPendingUpload).toHaveBeenNthCalledWith(2, file2);
    expect(setComposerText).toHaveBeenCalledWith("please book this\nhttps://example.com/thing");
  });

  it("strips only `share` from the URL, keeping `keep`", async () => {
    readSharedPayload.mockResolvedValue({ files: [], title: "", text: "", url: "" });

    render(<Harness addPendingUpload={vi.fn()} />);

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalled();
    });

    const [target] = replace.mock.calls[0];
    expect(target).toContain("/chat/a1?");
    expect(target).toContain("keep");
    expect(target).not.toContain("share=");
  });

  it("does nothing when there is no share param", () => {
    mockSearchParams.current = new URLSearchParams("keep=");

    render(<Harness addPendingUpload={vi.fn()} />);

    expect(readSharedPayload).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not crash and still strips the share param when the cache read rejects", async () => {
    readSharedPayload.mockRejectedValue(new Error("cache read failed"));
    const addPendingUpload = vi.fn();

    render(<Harness addPendingUpload={addPendingUpload} />);

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalled();
    });

    expect(addPendingUpload).not.toHaveBeenCalled();
    expect(clearSharedPayload).not.toHaveBeenCalled();
  });

  it("runs only once even if the component rerenders", async () => {
    readSharedPayload.mockResolvedValue({ files: [], title: "", text: "hi", url: "" });
    const setComposerText = vi.fn();

    const { rerender } = render(
      <Harness addPendingUpload={vi.fn()} setComposerText={setComposerText} />
    );

    await vi.waitFor(() => {
      expect(setComposerText).toHaveBeenCalledTimes(1);
    });

    rerender(<Harness addPendingUpload={vi.fn()} setComposerText={setComposerText} />);
    rerender(<Harness addPendingUpload={vi.fn()} setComposerText={setComposerText} />);

    expect(readSharedPayload).toHaveBeenCalledTimes(1);
    expect(setComposerText).toHaveBeenCalledTimes(1);
  });
});
