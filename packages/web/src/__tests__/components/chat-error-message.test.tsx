import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
      />
    );

    const heading = screen.getByText(/couldn't respond/i);
    expect(heading).toHaveTextContent("Smithers couldn't respond");
    expect(heading).not.toHaveTextContent("Smitherscouldn't respond");
  });

  it("should render provider error without hint when hint is null", () => {
    render(
      <ChatErrorMessage
        error={{
          agentName: "Smithers",
          providerError: "Something unexpected",
          hint: null,
        }}
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
      />
    );

    expect(container.firstElementChild).toHaveAttribute("role", "alert");
  });
});
