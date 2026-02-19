// packages/web/src/__tests__/components/provider-key-form.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ProviderKeyForm } from "@/components/provider-key-form";

global.fetch = vi.fn();

describe("ProviderKeyForm", () => {
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render three provider buttons", () => {
    render(<ProviderKeyForm onSuccess={onSuccess} />);

    expect(screen.getByRole("button", { name: /anthropic/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /openai/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /google/i })).toBeInTheDocument();
  });

  it("should show API key field when a provider is selected", () => {
    render(<ProviderKeyForm onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));

    expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
  });

  it("should show provider-specific placeholder", () => {
    render(<ProviderKeyForm onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));

    expect(screen.getByPlaceholderText("sk-ant-...")).toBeInTheDocument();
  });

  it("should disable submit button when no key entered", () => {
    render(<ProviderKeyForm onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));

    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });

  it("should show encryption hint", () => {
    render(<ProviderKeyForm onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));

    expect(screen.getByText(/encrypted at rest/i)).toBeInTheDocument();
  });

  it("should call onSuccess after successful submission", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    render(<ProviderKeyForm onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: "sk-ant-valid-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("should show error on failed validation", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Invalid API key. Please check and try again." }),
    } as Response);

    render(<ProviderKeyForm onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: "sk-ant-invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText(/invalid api key/i)).toBeInTheDocument();
    });
  });

  it("should show loading state during submission", async () => {
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                json: async () => ({ success: true }),
              } as Response),
            100
          )
        )
    );

    render(<ProviderKeyForm onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: "sk-ant-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(screen.getByText(/validating/i)).toBeInTheDocument();
  });

  it("should use custom submitLabel", () => {
    render(<ProviderKeyForm onSuccess={onSuccess} submitLabel="Save" />);

    fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: "sk-ant-key" },
    });

    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  describe("provider help guide", () => {
    it("should show help trigger when a provider is selected", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));

      expect(screen.getByText(/need help getting a key/i)).toBeInTheDocument();
    });

    it("should not show guide steps by default", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));

      expect(screen.queryByText(/sign up/i)).not.toBeInTheDocument();
    });

    it("should expand to show guide steps when clicked", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
      fireEvent.click(screen.getByText(/need help getting a key/i));

      expect(screen.getByText(/sign up/i)).toBeInTheDocument();
      expect(screen.getByText(/create key/i)).toBeInTheDocument();
    });

    it("should include a direct link to the provider key page", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
      fireEvent.click(screen.getByText(/need help getting a key/i));

      const link = screen.getByRole("link", { name: /go to.*anthropic/i });
      expect(link).toHaveAttribute("href", expect.stringContaining("claude.com"));
      expect(link).toHaveAttribute("target", "_blank");
    });

    it("should show different guide when switching providers", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
      fireEvent.click(screen.getByText(/need help getting a key/i));

      expect(screen.getByRole("link", { name: /go to.*anthropic/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /openai/i }));
      fireEvent.click(screen.getByText(/need help getting a key/i));

      expect(screen.getByRole("link", { name: /go to.*openai/i })).toBeInTheDocument();
    });
  });
});
