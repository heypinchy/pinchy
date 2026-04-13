import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatErrorMessage } from "@/components/assistant-ui/chat-error-message";

describe("ChatErrorMessage", () => {
  it("should render provider error with agent name and hint", () => {
    render(
      <ChatErrorMessage
        error={{
          agentName: "Smithers",
          providerError: "Your credit balance is too low.",
          hint: "Go to Settings → Providers to check your API configuration.",
        }}
      />
    );

    expect(screen.getByText("Smithers couldn't respond")).toBeInTheDocument();
    expect(screen.getByText("Your credit balance is too low.")).toBeInTheDocument();
    expect(
      screen.getByText("Go to Settings → Providers to check your API configuration.")
    ).toBeInTheDocument();
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
});
