// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import SetupProviderPage from "@/app/setup/provider/page";
import {
  RUNTIME_READY_BUDGET_MS,
  RUNTIME_READY_POLL_MS,
} from "@/hooks/use-agent-runtime-readiness";
import type { ProviderName } from "@/lib/providers";

const pushMock = vi.fn();

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));
vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  apiGet: apiGetMock,
}));

// Capture onSaved so tests can call it with different providers
let capturedOnSaved:
  ((provider: ProviderName, hasVision: boolean, agentId?: string) => void) | undefined;

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

vi.mock("next/image", () => ({
  default: ({
    priority,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

let capturedOnSuccess: ((provider?: ProviderName) => void) | null = null;

vi.mock("@/components/provider-key-form", () => ({
  ProviderKeyForm: ({
    onSuccess,
    onSaved,
  }: {
    onSuccess: (provider?: ProviderName) => void;
    onSaved?: (provider: ProviderName, hasVision: boolean, agentId?: string) => void;
  }) => {
    capturedOnSuccess = onSuccess;
    capturedOnSaved = onSaved;
    return (
      <button onClick={() => onSuccess()} data-testid="mock-provider-form">
        MockProviderForm
      </button>
    );
  },
}));

vi.mock("@/components/setup/smithers-model-info-line", () => ({
  SmithersModelInfoLine: ({ modelId }: { modelId: string }) => (
    <p data-testid="smithers-model-info">{modelId}</p>
  ),
}));

describe("Setup Provider Page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnSuccess = null;
    capturedOnSaved = undefined;
    apiGetMock.mockResolvedValue({ agentDispatchable: true });
  });

  it("should render the Pinchy logo", () => {
    render(<SetupProviderPage />);
    const logo = screen.getByAltText("Pinchy");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "/pinchy-logo.svg");
  });

  it("should display page title", () => {
    render(<SetupProviderPage />);
    expect(screen.getByText("Connect your AI provider")).toBeInTheDocument();
  });

  // Same rename as the settings card heading: the wizard card says "AI
  // provider" in its title, so the description right below it must not fall
  // back to the old "LLM provider" wording.
  it("should display page description", () => {
    render(<SetupProviderPage />);
    expect(screen.getByText(/choose your ai provider and enter your api key/i)).toBeInTheDocument();
  });

  it("should render the ProviderKeyForm", () => {
    render(<SetupProviderPage />);
    expect(screen.getByTestId("mock-provider-form")).toBeInTheDocument();
  });

  it("should redirect to home when onSuccess is called without a provider", () => {
    render(<SetupProviderPage />);
    fireEvent.click(screen.getByTestId("mock-provider-form"));
    expect(pushMock).toHaveBeenCalledWith("/");
  });

  it("should show success state when onSuccess is called with a provider", async () => {
    render(<SetupProviderPage />);
    capturedOnSuccess!("anthropic");
    await waitFor(() => {
      expect(screen.getByText("Provider connected!")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("mock-provider-form")).not.toBeInTheDocument();
  });

  it("should show model info line in success state", async () => {
    render(<SetupProviderPage />);
    capturedOnSuccess!("anthropic");
    await waitFor(() => {
      expect(screen.getByTestId("smithers-model-info")).toBeInTheDocument();
    });
    expect(screen.getByTestId("smithers-model-info")).toHaveTextContent(
      "anthropic/claude-sonnet-4-6"
    );
  });

  it("should redirect to home when Continue button is clicked in success state", async () => {
    render(<SetupProviderPage />);
    capturedOnSuccess!("anthropic");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /continue to pinchy/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /continue to pinchy/i }));
    expect(pushMock).toHaveBeenCalledWith("/");
  });

  it("warns when the configured provider has no vision-capable model", () => {
    render(<SetupProviderPage />);
    // Simulate ProviderKeyForm saving an ollama-local provider with no vision
    act(() => {
      capturedOnSaved?.("ollama-local", false);
    });
    expect(screen.getByText(/no vision-capable model configured/i)).toBeInTheDocument();
    expect(screen.getByText(/image uploads, scanned pdfs/i)).toBeInTheDocument();
  });

  it("does not warn when the configured provider has vision-capable models", () => {
    render(<SetupProviderPage />);
    // Simulate ProviderKeyForm saving Anthropic (always vision-capable)
    act(() => {
      capturedOnSaved?.("anthropic", true);
    });
    expect(screen.queryByText(/no vision-capable model configured/i)).not.toBeInTheDocument();
  });

  it("warning does not block proceeding — redirect still happens on continue", () => {
    render(<SetupProviderPage />);
    act(() => {
      capturedOnSaved?.("ollama-local", false);
    });
    fireEvent.click(screen.getByTestId("mock-provider-form"));
    expect(pushMock).toHaveBeenCalledWith("/");
  });

  // #1150 — the gap between "provider saved" and "OpenClaw can dispatch to
  // Smithers" used to be spent inside POST /api/setup/provider, which on a
  // fresh install can be tens of seconds (the first secrets.json restarts the
  // gateway, and the restarts leave `config.apply` rate-limited). The wizard
  // showed a disabled "Validating..." button for the whole of it — a spinner
  // indistinguishable from a hang. The wait now lives here, where it has a
  // name, a budget and a way out.
  describe("agent runtime readiness", () => {
    function saveProvider(agentId?: string) {
      act(() => {
        capturedOnSaved?.("anthropic", true, agentId);
        capturedOnSuccess!("anthropic");
      });
    }

    it("holds Continue until OpenClaw reports the agent dispatchable", async () => {
      apiGetMock
        .mockResolvedValueOnce({ agentDispatchable: false })
        .mockResolvedValue({ agentDispatchable: true });

      render(<SetupProviderPage />);
      saveProvider("agent-1");

      const button = await screen.findByRole("button", { name: /continue to pinchy/i });
      expect(button).toBeDisabled();
      await waitFor(() => expect(button).toBeEnabled(), { timeout: 5000 });
      expect(apiGetMock).toHaveBeenCalledWith("/api/health/openclaw?agentId=agent-1");
    });

    it("names what it is waiting for rather than showing a bare spinner", async () => {
      apiGetMock.mockResolvedValue({ agentDispatchable: false });

      render(<SetupProviderPage />);
      saveProvider("agent-1");

      expect(await screen.findByText(/getting smithers ready/i)).toBeInTheDocument();
    });

    it("lets you through once the budget is spent, and says why", async () => {
      vi.useFakeTimers();
      try {
        apiGetMock.mockResolvedValue({ agentDispatchable: false });

        render(<SetupProviderPage />);
        saveProvider("agent-1");

        await act(async () => {
          await vi.advanceTimersByTimeAsync(RUNTIME_READY_BUDGET_MS + RUNTIME_READY_POLL_MS);
        });

        // A runtime that is merely slow must never trap someone in the wizard —
        // the first chat has its own dispatch-race retry behind it.
        expect(screen.getByRole("button", { name: /continue to pinchy/i })).toBeEnabled();
        expect(screen.getByText(/still catching up/i)).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    // The budget has to hold against a request that never answers, not only
    // against one that keeps saying "not yet". `apiGet` issues a bare `fetch`
    // with no signal, and `/api/health/openclaw?agentId=` waits on an OpenClaw
    // RPC — so a gateway wedged mid-restart, or a Pinchy container that goes
    // away between two polls, leaves the poll suspended. A deadline that is
    // only read after the request settles is not a deadline: the button stays
    // disabled for as long as the browser keeps the socket, which is the hang
    // this whole change removes, one layer up.
    it("gives up on the budget even when the health request never answers", async () => {
      vi.useFakeTimers();
      try {
        apiGetMock.mockReturnValue(new Promise(() => {}));

        render(<SetupProviderPage />);
        saveProvider("agent-1");

        await act(async () => {
          await vi.advanceTimersByTimeAsync(RUNTIME_READY_BUDGET_MS + RUNTIME_READY_POLL_MS);
        });

        expect(screen.getByRole("button", { name: /continue to pinchy/i })).toBeEnabled();
        expect(screen.getByText(/still catching up/i)).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not gate Continue when the save reported no agent id", async () => {
      render(<SetupProviderPage />);
      act(() => {
        capturedOnSuccess!("anthropic");
      });

      expect(await screen.findByRole("button", { name: /continue to pinchy/i })).toBeEnabled();
      // Nothing was pushed to OpenClaw (or the response predates the field), so
      // there is no reload to wait for and polling would only delay the user.
      expect(apiGetMock).not.toHaveBeenCalled();
    });
  });
});
