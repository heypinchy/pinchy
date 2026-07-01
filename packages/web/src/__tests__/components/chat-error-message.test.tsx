import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChatErrorMessage } from "@/components/assistant-ui/chat-error-message";

describe("ChatErrorMessage — transient (rate limit / overloaded) branch", () => {
  it("renders honest, rate-limit-specific copy for a rate_limit transient error", () => {
    render(
      <ChatErrorMessage
        error={{
          agentName: "Penny",
          transientError: { kind: "transient", reason: "rate_limit", sideEffects: false },
        }}
        agentId="agent-1"
      />
    );

    expect(screen.getByText("Penny paused")).toBeInTheDocument();
    expect(screen.getByText(/rate-limiting/i)).toBeInTheDocument();
  });

  it("does NOT claim 'rate limit' when the transient cause is overloaded", () => {
    render(
      <ChatErrorMessage
        error={{
          agentName: "Penny",
          transientError: { kind: "transient", reason: "overloaded", sideEffects: false },
        }}
        agentId="agent-1"
      />
    );

    expect(screen.getByText(/overloaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/rate.?limit/i)).not.toBeInTheDocument();
  });

  it("warns about possible duplicate side effects when the run already acted", () => {
    render(
      <ChatErrorMessage
        error={{
          agentName: "Penny",
          transientError: { kind: "transient", reason: "rate_limit", sideEffects: true },
        }}
        agentId="agent-1"
      />
    );

    expect(screen.getByTestId("side-effects-warning")).toHaveTextContent(/duplicat/i);
  });

  it("omits the side-effects warning for a read-only run", () => {
    render(
      <ChatErrorMessage
        error={{
          agentName: "Penny",
          transientError: { kind: "transient", reason: "rate_limit", sideEffects: false },
        }}
        agentId="agent-1"
      />
    );

    expect(screen.queryByTestId("side-effects-warning")).not.toBeInTheDocument();
  });

  it("uses an assertive alert role for a live error and a polite status role for a historical one", () => {
    const { rerender } = render(
      <ChatErrorMessage
        error={{
          agentName: "Penny",
          transientError: { kind: "transient", reason: "rate_limit", sideEffects: false },
        }}
        agentId="agent-1"
      />
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(
      <ChatErrorMessage
        error={{
          agentName: "Penny",
          transientError: { kind: "transient", reason: "rate_limit", sideEffects: false },
        }}
        agentId="agent-1"
        historical
      />
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("calls onDismiss when the dismiss control is clicked", () => {
    const onDismiss = vi.fn();
    render(
      <ChatErrorMessage
        error={{
          agentName: "Penny",
          transientError: { kind: "transient", reason: "rate_limit", sideEffects: false },
        }}
        agentId="agent-1"
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("ChatErrorMessage — dismiss on the generic provider-error variant", () => {
  // The durable banner now shows for non-transient retryable classes too
  // (model_unavailable, silent_stream_timeout, schema_rejection,
  // failover_incomplete_stream), which render via the GENERIC provider-error
  // branch — not the transient one. That branch previously ignored onDismiss,
  // so the banner had only a Retry button and no way to clear it. It must now
  // honor onDismiss like the transient variant does.
  it("renders a dismiss control and calls onDismiss when clicked", () => {
    const onDismiss = vi.fn();
    render(
      <ChatErrorMessage
        error={{
          agentName: "Sterling Ollama",
          providerError: "LLM request failed. (model: ollama-cloud/some-model)",
        }}
        agentId="agent-1"
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders NO dismiss control when onDismiss is absent (inline thread usage)", () => {
    // Inline errors in the thread pass no onDismiss — you don't 'dismiss' a
    // conversation turn. The X must only appear when a caller (the banner) asks.
    render(
      <ChatErrorMessage
        error={{ agentName: "Sterling Ollama", providerError: "LLM request failed." }}
        agentId="agent-1"
      />
    );
    expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
  });
});

describe("ChatErrorMessage", () => {
  it("should render provider error with agent name and hint", () => {
    render(
      <ChatErrorMessage
        error={{
          agentName: "Smithers",
          providerError: "Your credit balance is too low.",
          hint: "Go to Settings > AI Provider to check your API configuration.",
        }}
        agentId="agent-1"
      />
    );

    expect(screen.getByText("Smithers couldn't respond")).toBeInTheDocument();
    expect(screen.getByText("Your credit balance is too low.")).toBeInTheDocument();
    expect(screen.getByTestId("error-hint")).toHaveTextContent(
      "Go to Settings > AI Provider to check your API configuration."
    );
    expect(screen.getByRole("link", { name: "Settings > AI Provider" })).toHaveAttribute(
      "href",
      "/settings?tab=provider"
    );
  });

  it("should render a space between agent name and couldn't", () => {
    render(
      <ChatErrorMessage
        error={{
          agentName: "Smithers",
          providerError: "Your credit balance is too low.",
        }}
        agentId="agent-1"
      />
    );

    const heading = screen.getByText(/couldn't respond/i);
    expect(heading).toHaveTextContent("Smithers couldn't respond");
    expect(heading).not.toHaveTextContent("Smitherscouldn't respond");
  });

  it("should render the heading as a single text node so flex whitespace collapse can't merge the words", () => {
    // Regression: "{agentLabel} couldn't respond" produced two adjacent text
    // nodes ("Smithers" and " couldn't respond"). In a flex container, each
    // becomes an anonymous flex item and `white-space: normal` strips the
    // leading space of the second — rendering as "Smitherscouldn't respond".
    // Asserting a single text node guarantees no whitespace can be collapsed.
    render(
      <ChatErrorMessage
        error={{
          agentName: "Smithers",
          providerError: "Your credit balance is too low.",
        }}
        agentId="agent-1"
      />
    );

    const heading = screen.getByText(/couldn't respond/i);
    const textNodes = Array.from(heading.childNodes).filter(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()
    );
    expect(textNodes).toHaveLength(1);
    expect(textNodes[0].textContent).toBe("Smithers couldn't respond");
  });

  it("should render provider error without hint when hint is null", () => {
    render(
      <ChatErrorMessage
        error={{
          agentName: "Smithers",
          providerError: "Something unexpected",
          hint: null,
        }}
        agentId="agent-1"
      />
    );

    expect(screen.getByText("Smithers couldn't respond")).toBeInTheDocument();
    expect(screen.getByText("Something unexpected")).toBeInTheDocument();
  });

  it("should render generic error message as fallback", () => {
    render(
      <ChatErrorMessage
        error={{
          message: "Access denied",
        }}
        agentId="agent-1"
      />
    );

    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(screen.queryByText("couldn't respond")).not.toBeInTheDocument();
  });

  it("should have destructive styling", () => {
    const { container } = render(
      <ChatErrorMessage
        error={{
          agentName: "Smithers",
          providerError: "Error text",
        }}
        agentId="agent-1"
      />
    );

    const errorCard = container.firstElementChild;
    expect(errorCard?.className).toContain("border-destructive");
    expect(errorCard?.className).toContain("bg-destructive");
  });

  it("should have warning icon", () => {
    render(
      <ChatErrorMessage
        error={{
          agentName: "Smithers",
          providerError: "Error text",
        }}
        agentId="agent-1"
      />
    );

    expect(screen.getByTestId("error-warning-icon")).toBeInTheDocument();
  });

  it("should have alert role for screen readers", () => {
    const { container } = render(
      <ChatErrorMessage
        error={{
          agentName: "Smithers",
          providerError: "Error text",
        }}
        agentId="agent-1"
      />
    );

    expect(container.firstElementChild).toHaveAttribute("role", "alert");
  });

  it("renders 'File too large' heading and detail message for payloadTooLarge variant", () => {
    render(
      <ChatErrorMessage
        error={{
          payloadTooLarge: true,
          message: "The file you attached is too large to send.",
        }}
      />
    );
    // The dedicated heading must be a <span> with exactly this text
    expect(screen.getByText("File too large")).toBeInTheDocument();
    // The detail message must also appear separately
    expect(screen.getByText("The file you attached is too large to send.")).toBeInTheDocument();
    // The too-large icon must be rendered
    expect(screen.getByTestId("too-large-icon")).toBeInTheDocument();
  });

  it("renders 'Invalid file' heading and detail message for attachmentInvalid variant", () => {
    render(
      <ChatErrorMessage
        error={{
          attachmentInvalid: true,
          message: "File type mismatch: claimed application/pdf, content is image/png",
        }}
      />
    );
    expect(screen.getByText("Invalid file")).toBeInTheDocument();
    expect(screen.getByText(/mismatch/i)).toBeInTheDocument();
    expect(screen.getByTestId("attachment-invalid-icon")).toBeInTheDocument();
  });
});

describe("ChatErrorMessage — modelUnavailable", () => {
  const baseError = {
    agentName: "Smithers",
    providerError: 'HTTP 500: "Internal Server Error (ref: abc-123)"',
    modelUnavailable: {
      kind: "model_unavailable" as const,
      model: "ollama-cloud/kimi-k2-thinking",
      httpStatus: 500,
      ref: "abc-123",
    },
  };

  it("renders the agent name and model", () => {
    render(<ChatErrorMessage error={baseError} agentId="agent-1" />);
    expect(screen.getByText(/Smithers couldn't respond/i)).toBeInTheDocument();
    expect(screen.getByText(/ollama-cloud\/kimi-k2-thinking/)).toBeInTheDocument();
  });

  it("renders 'Switch model' link to settings with model anchor", () => {
    render(<ChatErrorMessage error={baseError} agentId="agent-1" />);
    const link = screen.getByRole("link", { name: /switch model/i });
    expect(link).toHaveAttribute("href", "/chat/agent-1/settings?tab=general#model");
  });

  it("hides raw providerError behind a collapsible 'Technical details'", () => {
    render(<ChatErrorMessage error={baseError} agentId="agent-1" />);
    // Radix Collapsible does not render children when closed in JSDOM
    const technicalDetailsBtn = screen.getByRole("button", { name: /technical details/i });
    expect(technicalDetailsBtn).toBeInTheDocument();
    // Content is not rendered before clicking
    expect(screen.queryByText(/HTTP 500/)).not.toBeInTheDocument();
    fireEvent.click(technicalDetailsBtn);
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });

  it("falls back to legacy raw render when modelUnavailable absent", () => {
    render(
      <ChatErrorMessage
        error={{ agentName: "Smithers", providerError: "Network down" }}
        agentId="agent-1"
      />
    );
    expect(screen.getByText(/Network down/)).toBeInTheDocument();
  });

  it("uses role=alert for screen readers", () => {
    render(<ChatErrorMessage error={baseError} agentId="agent-1" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("hides the 'Switch model' link when agentId is empty (defensive: no broken /chat//settings link)", () => {
    // Defensive guard: AgentIdContext is always populated in real usage, but
    // if it ever returns undefined the parent passes "" as a fallback. Render
    // the rest of the bubble (so the user still sees the error) but suppress
    // the deep link rather than producing href="/chat//settings?tab=general#model".
    render(<ChatErrorMessage error={baseError} agentId="" />);
    expect(screen.queryByRole("link", { name: /switch model/i })).not.toBeInTheDocument();
    // The headline and technical-details affordance still render
    expect(screen.getByText(/Smithers couldn't respond/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /technical details/i })).toBeInTheDocument();
  });
});

describe("ChatErrorMessage — upstreamFormatError (issue #338)", () => {
  const baseError = {
    agentName: "Smithers",
    providerError:
      "LLM request failed: provider rejected the request schema or tool payload. " +
      'rawError=400 "Function call is missing a thought_signature in functionCall parts. ' +
      '(ref: 3d5cf450)"',
    upstreamFormatError: {
      kind: "upstream_format_error" as const,
      model: "ollama-cloud/gemini-3-flash-preview",
      errorPattern: "thought_signature" as const,
      ref: "3d5cf450",
    },
  };

  it("renders the agent name in the headline", () => {
    render(<ChatErrorMessage error={baseError} agentId="agent-1" />);
    expect(screen.getByText(/Smithers couldn't respond/i)).toBeInTheDocument();
  });

  it("explains that this is a known upstream issue and that Retry usually clears it", () => {
    // Pain point from issue #338: the misleading generic provider-error
    // wording sounds like Pinchy's fault. The replacement copy must (a) say
    // it's upstream and (b) tell the user Retry is reliable, so they don't
    // give up after the first failure.
    render(<ChatErrorMessage error={baseError} agentId="agent-1" />);
    expect(screen.getByText(/retry/i)).toBeInTheDocument();
    expect(screen.getByText(/upstream|known/i)).toBeInTheDocument();
  });

  it("does not render the 'Switch model' link — the model isn't the problem here", () => {
    render(<ChatErrorMessage error={baseError} agentId="agent-1" />);
    expect(screen.queryByRole("link", { name: /switch model/i })).not.toBeInTheDocument();
  });

  it("hides raw providerError behind a collapsible 'Technical details'", () => {
    render(<ChatErrorMessage error={baseError} agentId="agent-1" />);
    const btn = screen.getByRole("button", { name: /technical details/i });
    expect(btn).toBeInTheDocument();
    expect(screen.queryByText(/Function call is missing/)).not.toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.getByText(/Function call is missing/)).toBeInTheDocument();
  });

  it("uses role=alert for screen readers", () => {
    render(<ChatErrorMessage error={baseError} agentId="agent-1" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("takes precedence over modelUnavailable when both somehow coexist (defensive: never offer 'Switch model' for a schema bug)", () => {
    // Real chunks should never set both at the same time (orthogonal classifiers
    // — see model-error-classifier test "does not collide"), but if a future
    // refactor accidentally produces both, we must render the upstream-format
    // bubble, not the modelUnavailable one. Otherwise users would see a
    // "Switch model" button suggesting their model choice is broken, when in
    // fact the next replay of the *same* model usually succeeds.
    render(
      <ChatErrorMessage
        error={{
          ...baseError,
          modelUnavailable: {
            kind: "model_unavailable",
            model: "ollama-cloud/gemini-3-flash-preview",
            httpStatus: 500,
            ref: "x",
          },
        }}
        agentId="agent-1"
      />
    );
    expect(screen.queryByRole("link", { name: /switch model/i })).not.toBeInTheDocument();
    expect(screen.getByText(/retry/i)).toBeInTheDocument();
  });
});
