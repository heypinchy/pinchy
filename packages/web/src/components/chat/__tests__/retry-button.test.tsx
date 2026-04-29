import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import React from "react";
import { ChatStatusContext } from "@/components/chat";
import { type ChatStatus } from "@/hooks/use-chat-status";
import { RetryButton } from "../retry-button";

function renderWith(status: ChatStatus) {
  return render(
    <ChatStatusContext.Provider value={status}>
      <RetryButton onClick={vi.fn()} />
    </ChatStatusContext.Provider>
  );
}

describe("RetryButton", () => {
  it("renders with label 'Retry'", () => {
    renderWith({ kind: "ready" });
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("is enabled when status is 'ready'", () => {
    renderWith({ kind: "ready" });
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeDisabled();
  });

  it("is disabled and spinning when status is 'responding'", () => {
    renderWith({ kind: "responding" });
    const button = screen.getByRole("button", { name: "Retry" });
    expect(button).toBeDisabled();
    const icon = button.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").toContain("animate-spin");
  });

  it("is disabled (no spin) when status is 'unavailable'", () => {
    renderWith({ kind: "unavailable", reason: "disconnected" });
    const button = screen.getByRole("button", { name: "Retry" });
    expect(button).toBeDisabled();
    const icon = button.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").not.toContain("animate-spin");
  });

  it("is disabled (no spin) when status is 'starting'", () => {
    renderWith({ kind: "starting" });
    const button = screen.getByRole("button", { name: "Retry" });
    expect(button).toBeDisabled();
    const icon = button.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").not.toContain("animate-spin");
  });

  it("calls onClick when clicked and status is ready", () => {
    const onClick = vi.fn();
    render(
      <ChatStatusContext.Provider value={{ kind: "ready" }}>
        <RetryButton onClick={onClick} />
      </ChatStatusContext.Provider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not call onClick when disabled (responding)", () => {
    const onClick = vi.fn();
    render(
      <ChatStatusContext.Provider value={{ kind: "responding" }}>
        <RetryButton onClick={onClick} />
      </ChatStatusContext.Provider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("sets tooltip when status is 'unavailable'", () => {
    renderWith({ kind: "unavailable", reason: "disconnected" });
    expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute("title");
  });

  it("sets tooltip when status is 'responding'", () => {
    renderWith({ kind: "responding" });
    expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute("title");
  });

  it("sets tooltip when status is 'starting'", () => {
    renderWith({ kind: "starting" });
    expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute("title");
  });

  it("does not set a title when status is 'ready'", () => {
    renderWith({ kind: "ready" });
    expect(screen.getByRole("button", { name: "Retry" })).not.toHaveAttribute("title");
  });
});
