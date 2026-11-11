// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useState } from "react";
import { ChatSessionProvider, useChatSession } from "@/components/chat-session-provider";
import { ChatSessionMounts } from "@/components/chat-session-mounts";
import { useChatConnection } from "@/lib/chat-connection-store";

// Mutable state that tests can override to control useWsRuntime's return value.
let mockIsRunning = false;
let mockConnectionRejection: "too_many_connections" | "rate_limited" | null = null;
let mockIsOffline = false;
let mockPayloadRejected = false;
let mockPathname = "/agents";

// Hoisted so tests can assert on navigation — the `/compact` and `/reset`
// commands must act on THIS session in place and never route away like `/new`.
const routerPushSpy = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({
    push: (...args: unknown[]) => routerPushSpy(...args),
    replace: vi.fn(),
  }),
}));

const toastSuccessSpy = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessSpy(...args),
    error: vi.fn(),
  },
}));

// Mock useWsRuntime to avoid opening real WebSockets in unit tests.
const useWsRuntimeSpy = vi.fn();

vi.mock("@/hooks/use-ws-runtime", () => ({
  useWsRuntime: (agentId: string, chatId?: string, onSlashCommand?: (c: unknown) => void) => {
    useWsRuntimeSpy(agentId, chatId, onSlashCommand);
    return {
      runtime: { __id: `rt-${agentId}` } as never,
      isRunning: mockIsRunning,
      isConnected: true,
      isHistoryLoaded: true,
      isReconcilingMessages: false,
      hasInitialContent: true,
      isOpenClawConnected: true,
      isDelayed: false,
      isOffline: mockIsOffline,
      connectionRejection: mockConnectionRejection,
      payloadRejected: mockPayloadRejected,
      onRetryContinue: vi.fn(),
      onRetryResend: vi.fn(),
    };
  },
}));

function seedBundle(agentId: string, publish: (b: any) => void) {
  publish({
    agentId,
    runtime: { __id: `seed-${agentId}` } as never,
    isRunning: false,
    isConnected: false,
    isHistoryLoaded: false,
    isReconcilingMessages: false,
    hasInitialContent: false,
    isOpenClawConnected: false,
    isDelayed: false,
    reconnectExhausted: false,
    payloadRejected: false,
    onRetryContinue: vi.fn(),
    onRetryResend: vi.fn(),
    lastError: null,
  });
}

describe("ChatSessionMounts", () => {
  beforeEach(() => {
    mockIsRunning = false;
    mockConnectionRejection = null;
    mockIsOffline = false;
    mockPayloadRejected = false;
    mockPathname = "/agents";
    routerPushSpy.mockClear();
  });

  // Restore stubbed globals (`fetch`) here rather than at the end of each test,
  // so a failing assertion can't leak the stub into the next one.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls useWsRuntime once per visited agentId", () => {
    function Visitor({ agentIds }: { agentIds: string[] }) {
      agentIds.forEach((id) => {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const session = useChatSession(id);
        if (!session.bundle) seedBundle(id, session.publish);
      });
      return null;
    }

    useWsRuntimeSpy.mockClear();

    render(
      <ChatSessionProvider>
        <Visitor agentIds={["agent-A", "agent-B"]} />
        <ChatSessionMounts />
      </ChatSessionProvider>
    );

    // chatId is undefined for legacy (no-chatId) sessions (#508).
    expect(useWsRuntimeSpy).toHaveBeenCalledWith("agent-A", undefined, expect.any(Function));
    expect(useWsRuntimeSpy).toHaveBeenCalledWith("agent-B", undefined, expect.any(Function));
  });

  it("passes the chatId to useWsRuntime for a chat-scoped session (#508)", () => {
    function Visitor() {
      const session = useChatSession("agent-A", "chat-x");
      if (!session.bundle) {
        session.publish({
          agentId: "agent-A",
          chatId: "chat-x",
          runtime: { __id: "seed-agent-A:chat-x" } as never,
          isRunning: false,
          isConnected: false,
          isHistoryLoaded: false,
          isReconcilingMessages: false,
          hasInitialContent: false,
          isOpenClawConnected: false,
          isDelayed: false,
          reconnectExhausted: false,
          payloadRejected: false,
          onRetryContinue: vi.fn(),
          onRetryResend: vi.fn(),
          lastError: null,
        } as any);
      }
      return null;
    }

    useWsRuntimeSpy.mockClear();

    render(
      <ChatSessionProvider>
        <Visitor />
        <ChatSessionMounts />
      </ChatSessionProvider>
    );

    expect(useWsRuntimeSpy).toHaveBeenCalledWith("agent-A", "chat-x", expect.any(Function));
  });

  it("runs /compact against the compact route and toasts success (#611)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    function Visitor() {
      const session = useChatSession("agent-A", "chat-x");
      if (!session.bundle) {
        session.publish({
          agentId: "agent-A",
          chatId: "chat-x",
          runtime: { __id: "seed" } as never,
          isRunning: false,
          isConnected: false,
          isHistoryLoaded: false,
          isReconcilingMessages: false,
          hasInitialContent: false,
          isOpenClawConnected: false,
          isDelayed: false,
          reconnectExhausted: false,
          payloadRejected: false,
          onRetryContinue: vi.fn(),
          onRetryResend: vi.fn(),
          lastError: null,
        } as any);
      }
      return null;
    }

    useWsRuntimeSpy.mockClear();
    toastSuccessSpy.mockClear();

    render(
      <ChatSessionProvider>
        <Visitor />
        <ChatSessionMounts />
      </ChatSessionProvider>
    );

    // The third arg passed to useWsRuntime is the slash-command handler.
    const lastCall = useWsRuntimeSpy.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const onSlashCommand = lastCall![2] as (c: { name: string }) => void;
    expect(typeof onSlashCommand).toBe("function");

    await act(async () => {
      onSlashCommand({ name: "compact" });
      // Flush the apiPost microtasks behind the success toast.
      await new Promise((r) => setTimeout(r, 0));
    });

    // Hit the compact route for THIS chat's session...
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/agent-A/sessions/compact",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ chatId: "chat-x" }) })
    );
    // ...and stay put: compaction acts in place, unlike /new.
    expect(routerPushSpy).not.toHaveBeenCalled();
    expect(toastSuccessSpy).toHaveBeenCalledWith(expect.stringContaining("compacted"));
  });

  it("runs /reset against the reset route and remounts the thread (#611)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    function Visitor() {
      const session = useChatSession("agent-A", "chat-x");
      if (!session.bundle) {
        session.publish({
          agentId: "agent-A",
          chatId: "chat-x",
          runtime: { __id: "seed" } as never,
          isRunning: false,
          isConnected: false,
          isHistoryLoaded: false,
          isReconcilingMessages: false,
          hasInitialContent: false,
          isOpenClawConnected: false,
          isDelayed: false,
          reconnectExhausted: false,
          payloadRejected: false,
          onRetryContinue: vi.fn(),
          onRetryResend: vi.fn(),
          lastError: null,
        } as any);
      }
      return null;
    }

    useWsRuntimeSpy.mockClear();
    toastSuccessSpy.mockClear();

    render(
      <ChatSessionProvider>
        <Visitor />
        <ChatSessionMounts />
      </ChatSessionProvider>
    );

    const mountsBefore = useWsRuntimeSpy.mock.calls.filter(
      (c: string[]) => c[0] === "agent-A"
    ).length;
    const onSlashCommand = useWsRuntimeSpy.mock.calls.at(-1)![2] as (c: { name: string }) => void;

    await act(async () => {
      onSlashCommand({ name: "reset" });
      // Flush the apiPost microtasks and the subsequent remount setState.
      await new Promise((r) => setTimeout(r, 0));
    });

    // Hit the reset route for THIS chat's session...
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/agent-A/sessions/reset",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ chatId: "chat-x" }) })
    );
    // ...and stay put: reset clears in place, unlike /new.
    expect(routerPushSpy).not.toHaveBeenCalled();
    // The bumped nonce changes the instance's React key → remount → a fresh
    // useWsRuntime call, cold-starting the (now-empty) session.
    const mountsAfter = useWsRuntimeSpy.mock.calls.filter(
      (c: string[]) => c[0] === "agent-A"
    ).length;
    expect(mountsAfter).toBeGreaterThan(mountsBefore);
    expect(toastSuccessSpy).toHaveBeenCalledWith(expect.stringContaining("reset"));
  });

  it("keeps a mount alive when an unrelated child remounts", () => {
    useWsRuntimeSpy.mockClear();

    function Page({ visible }: { visible: boolean }) {
      const session = useChatSession("agent-A");
      if (!session.bundle && visible) {
        seedBundle("agent-A", session.publish);
      }
      return visible ? <div>page</div> : <div>other</div>;
    }

    function Harness() {
      const [visible, setVisible] = useState(true);
      return (
        <ChatSessionProvider>
          <button data-testid="toggle" onClick={() => setVisible((v) => !v)}>
            t
          </button>
          <Page visible={visible} />
          <ChatSessionMounts />
        </ChatSessionProvider>
      );
    }

    const { getByTestId } = render(<Harness />);

    act(() => {
      getByTestId("toggle").click();
    });
    act(() => {
      getByTestId("toggle").click();
    });

    const aCalls = useWsRuntimeSpy.mock.calls.filter((c: string[]) => c[0] === "agent-A");
    expect(aCalls.length).toBeGreaterThanOrEqual(1);
    expect(aCalls.length).toBeLessThanOrEqual(3);
  });

  describe("background-run telemetry", () => {
    function TelemetryHarness({ agentId, trigger }: { agentId: string; trigger: number }) {
      const session = useChatSession(agentId);
      if (!session.bundle) seedBundle(agentId, session.publish);
      // Expose trigger so re-renders happen when it changes
      return <span data-trigger={trigger} />;
    }

    it("calls fetch when isRunning flips true → false and user is NOT on the agent chat page", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => "" });
      vi.stubGlobal("fetch", fetchMock);

      mockPathname = "/agents";
      mockIsRunning = true;

      const { rerender } = render(
        <ChatSessionProvider>
          <TelemetryHarness agentId="agent-telemetry" trigger={1} />
          <ChatSessionMounts />
        </ChatSessionProvider>
      );

      // Simulate turn ending: flip isRunning to false and force a re-render
      mockIsRunning = false;
      await act(async () => {
        rerender(
          <ChatSessionProvider>
            <TelemetryHarness agentId="agent-telemetry" trigger={2} />
            <ChatSessionMounts />
          </ChatSessionProvider>
        );
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/audit/background-run",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("does NOT call fetch when isRunning flips true → false and user IS on the agent chat page", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => "" });
      vi.stubGlobal("fetch", fetchMock);

      mockPathname = "/chat/agent-on-chat";
      mockIsRunning = true;

      const { rerender } = render(
        <ChatSessionProvider>
          <TelemetryHarness agentId="agent-on-chat" trigger={1} />
          <ChatSessionMounts />
        </ChatSessionProvider>
      );

      mockIsRunning = false;
      await act(async () => {
        rerender(
          <ChatSessionProvider>
            <TelemetryHarness agentId="agent-on-chat" trigger={2} />
            <ChatSessionMounts />
          </ChatSessionProvider>
        );
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does NOT call fetch on initial render when isRunning is already false", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => "" });
      vi.stubGlobal("fetch", fetchMock);

      mockPathname = "/agents";
      mockIsRunning = false;

      await act(async () => {
        render(
          <ChatSessionProvider>
            <TelemetryHarness agentId="agent-cold-start" trigger={1} />
            <ChatSessionMounts />
          </ChatSessionProvider>
        );
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("lastError publishing", () => {
    function Harness({ agentId, onBundle }: { agentId: string; onBundle: (b: any) => void }) {
      const session = useChatSession(agentId);
      // Seed once so ChatSessionMounts mounts the instance for this agent.
      if (!session.bundle) seedBundle(agentId, session.publish);
      if (session.bundle) onBundle(session.bundle);
      return null;
    }

    function lastBundleFor(agentId: string, mockSetup: () => void) {
      mockSetup();
      const observed: any[] = [];
      render(
        <ChatSessionProvider>
          <Harness agentId={agentId} onBundle={(b) => observed.push(b)} />
          <ChatSessionMounts />
        </ChatSessionProvider>
      );
      // Last bundle observed reflects ChatSessionInstance's useEffect publish
      // (which overwrites the seed with the real useWsRuntime values).
      return observed[observed.length - 1];
    }

    it("publishes a lastError that says we are still retrying when the server refused the connection", () => {
      const bundle = lastBundleFor("agent-refused", () => {
        mockConnectionRejection = "too_many_connections";
      });
      expect(bundle?.lastError).toMatch(/too many/i);
      expect(bundle?.lastError).toMatch(/retry|trying/i);
      // Retrying is automatic: no copy may say reload is the only way out.
      expect(bundle?.lastError).not.toMatch(/reload/i);
    });

    it("names the rate limit when that is what refused the connection", () => {
      const bundle = lastBundleFor("agent-rate-limited", () => {
        mockConnectionRejection = "rate_limited";
      });
      expect(bundle?.lastError).toMatch(/too quickly|rate/i);
      expect(bundle?.lastError).not.toMatch(/reload/i);
    });

    it("publishes lastError=null for a plain outage and for being offline", () => {
      // An outage heals itself (and the chat says so); the sidebar's red dot is
      // for what needs a person, and nothing here needs a reload.
      expect(lastBundleFor("agent-offline", () => (mockIsOffline = true))?.lastError).toBeNull();
    });

    it("publishes lastError=null when the connection is healthy", () => {
      // Per-turn failures are authoritative `liveness: failed` verdicts rendered
      // as a thread bubble — they are NOT surfaced as a sidebar lastError.
      const bundle = lastBundleFor("agent-healthy", () => {});
      expect(bundle?.lastError).toBeNull();
    });
  });

  describe("connection info for the chat (#1422)", () => {
    function Seed({ agentId }: { agentId: string }) {
      const session = useChatSession(agentId);
      if (!session.bundle) seedBundle(agentId, session.publish);
      return null;
    }
    function Probe({ agentId, onInfo }: { agentId: string; onInfo: (i: unknown) => void }) {
      onInfo(useChatConnection(agentId));
      return null;
    }

    it("hands the chat the offline flag and the refusal reason the runtime reports", () => {
      mockIsOffline = true;
      mockConnectionRejection = "rate_limited";
      let info: unknown;
      render(
        <ChatSessionProvider>
          <Seed agentId="agent-info" />
          <ChatSessionMounts />
          <Probe agentId="agent-info" onInfo={(i) => (info = i)} />
        </ChatSessionProvider>
      );
      expect(info).toEqual({ isOffline: true, rejection: "rate_limited" });
    });

    it("forgets the connection info when the instance unmounts", () => {
      mockIsOffline = true;
      let info: unknown;
      const { unmount } = render(
        <ChatSessionProvider>
          <Seed agentId="agent-gone" />
          <ChatSessionMounts />
        </ChatSessionProvider>
      );
      unmount();
      render(<Probe agentId="agent-gone" onInfo={(i) => (info = i)} />);
      expect(info).toEqual({ isOffline: false, rejection: null });
    });
  });
});
