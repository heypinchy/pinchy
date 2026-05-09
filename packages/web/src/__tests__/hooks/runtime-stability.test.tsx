// Regression guard for the assistant-ui contract that #199 relies on:
// the runtime instance, created once at a parent component, must survive
// mount/unmount cycles of <AssistantRuntimeProvider> in a child — AND any
// state mutated while the consumer is unmounted must be visible when the
// consumer re-mounts.
//
// This is the load-bearing assumption behind hoisting `useWsRuntime` into
// <ChatSessionInstance> under (app)/layout while letting <Chat> mount and
// unmount freely as the user navigates. If a future assistant-ui upgrade
// breaks this contract, the in-app navigation persistence feature silently
// regresses (chats appear to "reset" on every navigation). These tests
// pin the contract so that breakage shows up here, not in production.

import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useState, type FC } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  ThreadPrimitive,
  MessagePrimitive,
  type ThreadMessageLike,
  type AssistantRuntime,
} from "@assistant-ui/react";

// Minimal "external store" — we control state via mutation, runtime mirrors it.
type Store = {
  messages: ThreadMessageLike[];
  isRunning: boolean;
};

// Render the runtime's view of messages — proves the runtime is wired.
const ThreadView: FC = () => (
  <ThreadPrimitive.Root>
    <ThreadPrimitive.Viewport>
      <ThreadPrimitive.Messages
        components={{
          UserMessage: () => (
            <div data-testid="user-msg">
              <MessagePrimitive.Parts />
            </div>
          ),
          AssistantMessage: () => (
            <div data-testid="assistant-msg">
              <MessagePrimitive.Parts />
            </div>
          ),
        }}
      />
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root>
);

// Parent owns the runtime via useExternalStoreRuntime. Mounted once.
// Toggles a child mount via the `mounted` prop — the question is whether the
// runtime's state survives the child's unmount/remount.
function Harness({
  store,
  mounted,
  onRuntimeReady,
}: {
  store: Store;
  mounted: boolean;
  onRuntimeReady?: (rt: AssistantRuntime) => void;
}) {
  const runtime = useExternalStoreRuntime({
    messages: store.messages,
    isRunning: store.isRunning,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {},
  });

  // Surface the runtime instance for identity checks across renders.
  if (onRuntimeReady) onRuntimeReady(runtime);

  return (
    <div>
      <span data-testid="runtime-id">{describeRuntime(runtime)}</span>
      {mounted && (
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadView />
        </AssistantRuntimeProvider>
      )}
    </div>
  );
}

function describeRuntime(rt: AssistantRuntime): string {
  // The runtime is an opaque instance — surface a stable-per-instance
  // identity for cross-render comparison without depending on internals.
  // We use the object identity directly: React rerender can't change it
  // unless the underlying useState seed re-fired, which is what we test.
  return String((rt as unknown as { __identity?: number }).__identity ?? "");
}

// Tag each runtime once with a monotonic counter so we can compare identity
// across renders (tagged via WeakMap to avoid mutating the runtime).
const runtimeTags = new WeakMap<object, number>();
let runtimeCounter = 0;
function tagRuntime(rt: AssistantRuntime): number {
  const obj = rt as unknown as object;
  let id = runtimeTags.get(obj);
  if (id === undefined) {
    id = ++runtimeCounter;
    runtimeTags.set(obj, id);
  }
  return id;
}

describe("[spike] assistant-ui runtime stability across consumer remount", () => {
  it("the runtime instance is stable across re-renders of the parent", () => {
    const store: Store = { messages: [], isRunning: false };
    let lastRuntime: AssistantRuntime | undefined;
    const seen = new Set<number>();

    const { rerender } = render(
      <Harness
        store={store}
        mounted={true}
        onRuntimeReady={(rt) => {
          seen.add(tagRuntime(rt));
          lastRuntime = rt;
        }}
      />
    );

    rerender(
      <Harness
        store={store}
        mounted={true}
        onRuntimeReady={(rt) => {
          seen.add(tagRuntime(rt));
          lastRuntime = rt;
        }}
      />
    );

    expect(seen.size).toBe(1);
    expect(lastRuntime).toBeDefined();
  });

  it("the consumer can be unmounted and remounted, runtime instance unchanged", () => {
    const store: Store = { messages: [], isRunning: false };
    const seen = new Set<number>();

    const { rerender } = render(
      <Harness store={store} mounted={true} onRuntimeReady={(rt) => seen.add(tagRuntime(rt))} />
    );

    // Unmount the consumer
    rerender(
      <Harness store={store} mounted={false} onRuntimeReady={(rt) => seen.add(tagRuntime(rt))} />
    );

    // Remount it
    rerender(
      <Harness store={store} mounted={true} onRuntimeReady={(rt) => seen.add(tagRuntime(rt))} />
    );

    expect(seen.size).toBe(1);
  });

  it("state mutations while the consumer is unmounted are visible after remount", async () => {
    const initialMessages: ThreadMessageLike[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];

    const Wrapper: FC = () => {
      const [store, setStore] = useState<Store>({ messages: initialMessages, isRunning: false });
      const [mounted, setMounted] = useState(true);

      return (
        <div>
          <button data-testid="toggle-mount" onClick={() => setMounted((m) => !m)}>
            toggle
          </button>
          <button
            data-testid="add-msg"
            onClick={() =>
              setStore((s) => ({
                ...s,
                messages: [
                  ...s.messages,
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "from-background" }],
                  },
                ],
              }))
            }
          >
            add
          </button>
          <Harness store={store} mounted={mounted} />
        </div>
      );
    };

    render(<Wrapper />);

    // 1. Initially mounted — user msg is rendered.
    expect(screen.getByTestId("user-msg")).toHaveTextContent("hello");

    // 2. Unmount the consumer.
    await act(async () => {
      screen.getByTestId("toggle-mount").click();
    });
    expect(screen.queryByTestId("user-msg")).toBeNull();

    // 3. Mutate state while consumer is unmounted.
    await act(async () => {
      screen.getByTestId("add-msg").click();
    });

    // 4. Remount the consumer.
    await act(async () => {
      screen.getByTestId("toggle-mount").click();
    });

    // 5. Both messages must be visible — the one from before unmount AND
    //    the one added while unmounted. This is the architectural claim:
    //    runtime state is persistent, consumer rendering is incidental.
    expect(screen.getByTestId("user-msg")).toHaveTextContent("hello");
    expect(screen.getByTestId("assistant-msg")).toHaveTextContent("from-background");
  });
});
