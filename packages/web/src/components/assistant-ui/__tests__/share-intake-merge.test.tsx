// Behavioural guard for the share prefill against the REAL assistant-ui
// composer: ShareIntake and DraftPersistence both write the same composer's
// text, so a shared payload arriving into a chat that already has a restored
// draft must APPEND to it, not clobber it. The overwrite bug is invisible to
// the hook-level use-share-intake.test.tsx (which mocks setComposerText), so
// this file drives the real `useComposerRuntime` getState/setText path where
// the merge actually happens.
import { render, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEffect, type FC } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useComposerRuntime,
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type ComposerRuntime,
} from "@assistant-ui/react";
import { ShareIntake } from "@/components/assistant-ui/thread";
import { AddPendingUploadContext } from "@/components/chat";

const { readSharedPayload, clearSharedPayload } = vi.hoisted(() => ({
  readSharedPayload: vi.fn(),
  clearSharedPayload: vi.fn(),
}));

vi.mock("@/lib/share-target/share-cache", () => ({
  readSharedPayload,
  clearSharedPayload,
}));

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/chat/a1",
  useSearchParams: () => new URLSearchParams("keep=&share=abc"),
}));

let composerApi: ComposerRuntime | null = null;
const CaptureComposer: FC = () => {
  const composer = useComposerRuntime();
  useEffect(() => {
    composerApi = composer;
  }, [composer]);
  return null;
};

const Harness: FC = () => {
  const runtime = useExternalStoreRuntime({
    messages: [] as ThreadMessageLike[],
    isRunning: false,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ComposerPrimitive.Root>
        <CaptureComposer />
        <AddPendingUploadContext.Provider value={() => {}}>
          <ShareIntake />
        </AddPendingUploadContext.Provider>
        <ComposerPrimitive.Input aria-label="Message input" />
      </ComposerPrimitive.Root>
    </AssistantRuntimeProvider>
  );
};

describe("ShareIntake text prefill (real composer)", () => {
  beforeEach(() => {
    readSharedPayload.mockReset();
    clearSharedPayload.mockReset();
    replace.mockReset();
    composerApi = null;
  });

  it("appends the shared text to an existing draft instead of overwriting it", async () => {
    // Hold the read open so we can seed the composer with a restored draft
    // BEFORE the shared payload lands — the exact ordering DraftPersistence
    // produces in the no-attachment case.
    let resolveRead: (v: unknown) => void = () => {};
    readSharedPayload.mockReturnValue(
      new Promise((r) => {
        resolveRead = r;
      })
    );

    render(<Harness />);
    await waitFor(() => expect(composerApi).not.toBeNull());

    act(() => {
      composerApi!.setText("my own draft");
    });

    await act(async () => {
      resolveRead({ files: [], title: "", text: "shared note", url: "" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(composerApi!.getState().text).toBe("my own draft\nshared note");
    });
    expect(clearSharedPayload).toHaveBeenCalledWith("abc");
  });

  it("sets the shared text directly when the composer is empty", async () => {
    readSharedPayload.mockResolvedValue({ files: [], title: "", text: "shared note", url: "" });

    render(<Harness />);

    await waitFor(() => {
      expect(composerApi!.getState().text).toBe("shared note");
    });
  });
});
