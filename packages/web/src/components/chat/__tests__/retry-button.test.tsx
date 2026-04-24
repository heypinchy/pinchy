import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import { RetryButton } from "../retry-button";

describe("RetryButton", () => {
  it("renders with label 'Retry'", () => {
    render(<RetryButton onClick={vi.fn()} disabled={false} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("is disabled when disabled prop is true", () => {
    render(<RetryButton onClick={vi.fn()} disabled={true} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<RetryButton onClick={onClick} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not call onClick when disabled and clicked", () => {
    const onClick = vi.fn();
    render(<RetryButton onClick={onClick} disabled={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
