import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChatErrorMessage } from "@/components/assistant-ui/chat-error-message";

describe("ChatErrorMessage", () => {
  it("should render provider error with agent name and hint", () => {
    render(
      <ChatErrorMessage
        error={{
          agentName: "Smithers",
          providerError: "Your credit balance is too low.",
          hint: "Go to Settings > Providers to check your API configuration.",
        }}
        agentId="agent-1"
      />
    );

    expect(screen.getByText("Smithers couldn't respond")).toBeInTheDocument();
    expect(screen.getByText("Your credit balance is too low.")).toBeInTheDocument();
    expect(screen.getByTestId("error-hint")).toHaveTextContent(
      "Go to Settings > Providers to check your API configuration."
    );
    expect(screen.getByRole("link", { name: "Settings > Providers" })).toHaveAttribute(
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

  it("renders 'Image too large' heading and detail message for payloadTooLarge variant", () => {
    render(
      <ChatErrorMessage
        error={{
          payloadTooLarge: true,
          message: "Image too large to send. Please use an image smaller than 15 MB.",
        }}
      />
    );
    // The dedicated heading must be a <span> with exactly this text
    expect(screen.getByText("Image too large")).toBeInTheDocument();
    // The detail message must also appear separately
    expect(
      screen.getByText("Image too large to send. Please use an image smaller than 15 MB.")
    ).toBeInTheDocument();
    // The too-large icon must be rendered
    expect(screen.getByTestId("too-large-icon")).toBeInTheDocument();
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
