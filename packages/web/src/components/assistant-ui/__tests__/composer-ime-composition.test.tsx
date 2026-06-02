// Regression guard for the IME / dead-key composition freeze.
//
// Bug history: typing an accented character such as "é" via a dead-key
// sequence (´ then e — two keystrokes, an IME composition) froze the chat
// input. No further characters could be entered and deletion stopped working.
//
// Root cause: the composer textarea is a CONTROLLED input — its value comes
// from the assistant-ui runtime (`composer.text`). The golden rule for a
// controlled input is that its value must NOT be written back to the DOM via
// state/re-render while an IME composition is active; doing so aborts the
// browser's composition session and freezes the field. assistant-ui 0.14.x
// regressed exactly here: `ComposerPrimitive.Input`'s onChange calls
// `setText(value)` UNCONDITIONALLY before the `if (isComposing) return` guard,
// so the runtime text — and therefore the controlled value — mutates mid
// composition. 0.12.x returned before `setText` and was safe.
//
// Why earlier tests never caught it: the sibling `thread.test.tsx` mocks
// `@assistant-ui/react` wholesale, replacing `ComposerPrimitive.Input` with a
// bare <textarea>. A bare textarea has none of the broken onChange logic, so a
// composition test there would exercise the mock, not the dependency. This
// file deliberately does NOT mock assistant-ui: it renders the REAL primitive
// against a REAL runtime so a regression in the dependency (a version bump, a
// removed guard) shows up HERE. This pins the assistant-ui contract our
// Composer relies on.
//
// Why this is a unit test and not an E2E: the actual freeze is an OS-IME <->
// Blink composition desync — React writes the controlled value back during a
// composition the OS still considers active. Headless browsers drive Blink's
// composition directly (e.g. CDP Input.imeSetComposition), bypassing the OS
// layer, so there is nothing to desync and the freeze does not reproduce. The
// faithfully testable, deterministic invariant is the proximate one asserted
// here: the runtime text (which backs the controlled value) must not change
// while a composition is active. Asserting it against the REAL primitive is
// exactly what the previous, deleted test failed to do — it mocked the
// primitive away and so could never see a dependency regression.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useEffect, type FC } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useComposerRuntime,
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type ComposerRuntime,
} from "@assistant-ui/react";

// Capture the live composer runtime so the test can read `composer.text`,
// which is the state that drives the controlled textarea value. If this state
// changes during an active composition, the controlled value gets written back
// to the DOM mid-composition — that is the freeze.
let composerApi: ComposerRuntime | null = null;
const CaptureComposer: FC = () => {
  const composer = useComposerRuntime();
  // Assign in an effect, not during render — render must stay side-effect free.
  // Testing Library flushes effects on render(), so composerApi is set by the
  // time the test reads it.
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
      <CaptureComposer />
      <ComposerPrimitive.Input aria-label="Message input" />
    </AssistantRuntimeProvider>
  );
};

// Set the textarea value the way the browser does — through the NATIVE value
// setter. React overrides the `value` property with a tracking setter, so a
// direct `textarea.value = x` assignment updates React's tracker and makes
// React believe nothing changed (it then skips onChange). Going through the
// prototype setter bypasses the tracker, exactly as Testing Library's own
// `fireEvent.change` does internally.
function setNativeValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )!.set!;
  setter.call(textarea, value);
}

// Dispatch a real `input` event carrying `isComposing === true` on its native
// event. React maps onChange to the native input event and the primitive reads
// `e.nativeEvent.isComposing`; a normal `fireEvent.change` leaves isComposing
// falsy, which 0.14's stale-ref recovery treats as "composition finished" — so
// we set it explicitly to model an in-flight composition faithfully. Verified
// against React 19: this delivers onChange with isComposing=true.
function fireComposingInput(textarea: HTMLTextAreaElement, value: string) {
  setNativeValue(textarea, value);
  const ev = new Event("input", { bubbles: true });
  Object.defineProperty(ev, "isComposing", { value: true, configurable: true });
  act(() => {
    fireEvent(textarea, ev);
  });
}

describe("ComposerPrimitive.Input IME composition (dead-key freeze guard)", () => {
  it("does NOT mutate composer text while an IME composition is active", () => {
    composerApi = null;
    render(<Harness />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(composerApi).not.toBeNull();
    // Precondition: the thread composer is editable, otherwise onChange no-ops
    // and the test would pass for the wrong reason.
    expect(composerApi!.getState().isEditing).toBe(true);

    // Dead-key sequence begins: the browser starts composing "´".
    fireEvent.compositionStart(textarea);
    // The composition resolves toward "é" — an `input` with isComposing=true.
    fireComposingInput(textarea, "é");

    // THE INVARIANT: runtime text (which drives the controlled value) must stay
    // empty during the composition. If it became "é" here, React would write
    // the controlled value back into the textarea mid-composition and freeze
    // the field. This is RED on assistant-ui 0.14.x (setText runs before the
    // isComposing guard) and GREEN once the guard precedes setText.
    expect(composerApi!.getState().text).toBe("");
  });

  it("syncs the composed character to the runtime once composition ends", () => {
    composerApi = null;
    render(<Harness />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.compositionStart(textarea);
    fireComposingInput(textarea, "é");
    // Composition commits — compositionend always syncs the final value, so the
    // character is not lost. This proves the guard only DEFERS the sync, it
    // does not drop input.
    setNativeValue(textarea, "é");
    act(() => {
      fireEvent.compositionEnd(textarea);
    });

    expect(composerApi!.getState().text).toBe("é");
  });
});
