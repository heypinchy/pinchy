"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useComposerRuntime } from "@assistant-ui/react";
import { SLASH_COMMANDS } from "@/lib/slash-commands";
import { cn } from "@/lib/utils";

/**
 * In-composer `/` autocomplete menu (#611) — the discoverability layer for the
 * slash commands.
 *
 * When the composer text is a leading `/` still being typed (slash + letters,
 * no space yet), a popover lists the matching commands with descriptions and
 * keyboard navigation (↑/↓, Enter to run, Tab to complete, Escape to dismiss).
 *
 * Deliberately built on assistant-ui's STABLE composer runtime API
 * (`getState`/`setText`/`send`/`subscribe`) rather than its native
 * `unstable_useSlashCommandAdapter` + `ComposerTriggerPopover`: those are marked
 * `@deprecated — under active development, may change without notice`, and this
 * is a primary, always-visible surface in a product that pins (and patches)
 * assistant-ui. Owning ~100 lines here buys upgrade-safety.
 *
 * Selection routes through the existing send-path intercept — `setText("/name")`
 * + `send()` reaches `use-ws-runtime`'s `onNew` → `parseSlashCommand` → the
 * ChatSessionMounts handler — so execution, audit, and the `/reset` remount are
 * reused, never duplicated here.
 */
export function useSlashCommandMenu() {
  const runtime = useComposerRuntime({ optional: true });
  const [text, setText] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!runtime) return;
    setText(runtime.getState().text);
    return runtime.subscribe(() => setText(runtime.getState().text));
  }, [runtime]);

  // The query is the command token WHILE it is still being typed: a leading
  // slash followed by letters and no space yet. Once a space (an arg) or a
  // non-letter is typed the menu closes — our commands take no args.
  const query = useMemo(() => {
    const m = text.match(/^\/([a-zA-Z]*)$/);
    return m ? m[1].toLowerCase() : null;
  }, [text]);

  const items = useMemo(
    () => (query === null ? [] : SLASH_COMMANDS.filter((c) => c.name.startsWith(query))),
    [query]
  );

  // Reset transient state whenever the query changes, so typing after an Escape
  // reopens the menu and the highlight starts at the top of the new list.
  useEffect(() => {
    setActiveIndex(0);
    setDismissed(false);
  }, [query]);

  const open = runtime != null && items.length > 0 && !dismissed;

  const runCommand = useCallback(
    (name: string) => {
      if (!runtime) return;
      runtime.setText(`/${name}`);
      runtime.send();
    },
    [runtime]
  );

  const onKeyDownCapture = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) return;
      // Never hijack keys mid-IME-composition (e.g. an Enter that commits a
      // Japanese candidate) — mirrors the composer's own composition guard.
      if (e.nativeEvent.isComposing) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setActiveIndex((i) => (i + 1) % items.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setActiveIndex((i) => (i - 1 + items.length) % items.length);
          break;
        case "Enter":
          if (e.shiftKey) return;
          e.preventDefault();
          e.stopPropagation();
          runCommand(items[activeIndex].name);
          break;
        case "Tab":
          // Complete the highlighted command into the input (with a trailing
          // space, which closes the menu) without running it.
          e.preventDefault();
          e.stopPropagation();
          runtime?.setText(`/${items[activeIndex].name} `);
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          setDismissed(true);
          break;
      }
    },
    [open, items, activeIndex, runCommand, runtime]
  );

  const listboxId = "slash-command-listbox";
  const activeOptionId = open ? `slash-cmd-${items[activeIndex]?.name}` : undefined;

  // Editable-combobox-with-list-autocomplete ARIA (W3C APG): the textarea keeps
  // DOM focus; the active option is tracked via aria-activedescendant so screen
  // readers announce it while the user keeps typing/filtering.
  const inputAriaProps = open
    ? ({
        role: "combobox",
        "aria-expanded": true,
        "aria-controls": listboxId,
        "aria-activedescendant": activeOptionId,
        "aria-autocomplete": "list",
      } as const)
    : {};

  return {
    open,
    items,
    activeIndex,
    setActiveIndex,
    onKeyDownCapture,
    runCommand,
    listboxId,
    inputAriaProps,
  };
}

export type SlashCommandMenu = ReturnType<typeof useSlashCommandMenu>;

export function SlashCommandMenuList({ menu }: { menu: SlashCommandMenu }) {
  if (!menu.open) return null;
  return (
    <div
      role="listbox"
      id={menu.listboxId}
      aria-label="Slash commands"
      className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {menu.items.map((c, i) => (
        <button
          type="button"
          key={c.name}
          id={`slash-cmd-${c.name}`}
          role="option"
          aria-selected={i === menu.activeIndex}
          // onMouseDown (not onClick) with preventDefault keeps focus in the
          // textarea so send() dispatches from a focused composer.
          onMouseDown={(e) => {
            e.preventDefault();
            menu.runCommand(c.name);
          }}
          onMouseEnter={() => menu.setActiveIndex(i)}
          className={cn(
            "flex w-full items-baseline gap-2 rounded-lg px-3 py-2 text-left text-sm",
            i === menu.activeIndex ? "bg-accent text-accent-foreground" : "text-foreground"
          )}
        >
          <span className="font-medium">/{c.name}</span>
          <span className="truncate text-xs text-muted-foreground">{c.description}</span>
        </button>
      ))}
    </div>
  );
}
