import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, within } from "@testing-library/react";
import {
  useSlashCommandMenu,
  SlashCommandMenuList,
} from "@/components/assistant-ui/slash-command-menu";

// A controllable fake ComposerRuntime exposing only the stable surface the menu
// uses (getState/setText/send/subscribe), plus a `_type` test helper that
// simulates the user editing the composer (updates text + notifies subscribers).
function makeFakeRuntime(initial = "") {
  let text = initial;
  const subs = new Set<() => void>();
  const notify = () => subs.forEach((f) => f());
  return {
    getState: () => ({ text }),
    setText: vi.fn((t: string) => {
      text = t;
      notify();
    }),
    send: vi.fn(),
    subscribe: (cb: () => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    _type: (t: string) => {
      text = t;
      notify();
    },
  };
}

let fakeRuntime: ReturnType<typeof makeFakeRuntime>;

vi.mock("@assistant-ui/react", () => ({
  useComposerRuntime: () => fakeRuntime,
}));

function Harness() {
  const menu = useSlashCommandMenu();
  return (
    <div onKeyDownCapture={menu.onKeyDownCapture}>
      <textarea data-testid="input" aria-label="Message input" {...menu.inputAriaProps} />
      <SlashCommandMenuList menu={menu} />
    </div>
  );
}

describe("SlashCommandMenu (#611)", () => {
  beforeEach(() => {
    fakeRuntime = makeFakeRuntime("");
  });

  function type(text: string) {
    act(() => fakeRuntime._type(text));
  }

  it("is closed when the composer is empty or holds a normal message", () => {
    const { queryByRole } = render(<Harness />);
    expect(queryByRole("listbox")).toBeNull();
    type("hello there");
    expect(queryByRole("listbox")).toBeNull();
  });

  it("opens with all commands when the user types '/'", () => {
    const { getByRole } = render(<Harness />);
    type("/");
    const listbox = getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("/compact"),
      expect.stringContaining("/new"),
      expect.stringContaining("/reset"),
      expect.stringContaining("/help"),
    ]);
  });

  it("filters as the command token is typed", () => {
    const { getByRole } = render(<Harness />);
    type("/c");
    const options = within(getByRole("listbox")).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("/compact");
  });

  it("closes once an argument (space) is typed — our commands take no args", () => {
    const { queryByRole } = render(<Harness />);
    type("/compact ");
    expect(queryByRole("listbox")).toBeNull();
  });

  it("runs the highlighted command on Enter (setText + send), and blocks the normal submit", () => {
    const { getByTestId } = render(<Harness />);
    type("/");
    const input = getByTestId("input");
    // Move to the second item (/new) then run it.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const enter = fireEvent.keyDown(input, { key: "Enter" });
    // preventDefault returns false from fireEvent when default was prevented.
    expect(enter).toBe(false);
    expect(fakeRuntime.setText).toHaveBeenCalledWith("/new");
    expect(fakeRuntime.send).toHaveBeenCalledTimes(1);
  });

  it("does not hijack Enter while an IME composition is in progress", () => {
    const { getByTestId } = render(<Harness />);
    type("/");
    const input = getByTestId("input");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(fakeRuntime.send).not.toHaveBeenCalled();
  });

  it("runs a command on click via mouseDown", () => {
    const { getByRole } = render(<Harness />);
    type("/");
    const compact = within(getByRole("listbox"))
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("/compact"))!;
    fireEvent.mouseDown(compact);
    expect(fakeRuntime.setText).toHaveBeenCalledWith("/compact");
    expect(fakeRuntime.send).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape and reopens when the user keeps typing", () => {
    const { getByTestId, queryByRole, getByRole } = render(<Harness />);
    type("/");
    expect(getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(getByTestId("input"), { key: "Escape" });
    expect(queryByRole("listbox")).toBeNull();
    // Typing more changes the query and reopens the menu.
    type("/h");
    expect(getByRole("listbox")).toBeTruthy();
  });

  it("exposes editable-combobox ARIA on the input while open", () => {
    const { getByTestId } = render(<Harness />);
    const input = getByTestId("input");
    expect(input.getAttribute("role")).toBeNull();
    type("/");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe("slash-command-listbox");
    expect(input.getAttribute("aria-activedescendant")).toBe("slash-cmd-compact");
  });
});
