// packages/web/src/__tests__/components/provider-key-form.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ProviderKeyForm } from "@/components/provider-key-form";

describe("ProviderKeyForm", () => {
  const onSuccess = vi.fn();
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
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
    vi.mocked(global.fetch).mockResolvedValueOnce({
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
    vi.mocked(global.fetch).mockResolvedValueOnce({
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

  it("should show error indicator next to input on failed validation", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Invalid API key." }),
    } as Response);

    render(<ProviderKeyForm onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: "sk-ant-invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByTestId("key-error-indicator")).toBeInTheDocument();
    });
  });

  it("should show loading state during submission", async () => {
    vi.mocked(global.fetch).mockImplementation(
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

    it("should link the provider domain in the signup step", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
      fireEvent.click(screen.getByText(/need help getting a key/i));

      const signupLink = screen.getByRole("link", { name: /platform\.claude\.com/i });
      expect(signupLink).toHaveAttribute("href", "https://platform.claude.com");
      expect(signupLink).toHaveAttribute("target", "_blank");
    });

    it("should link Google domain in the signup step", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /google/i }));
      fireEvent.click(screen.getByText(/need help getting a key/i));

      const signupLink = screen.getByRole("link", { name: /aistudio\.google\.com/i });
      expect(signupLink).toHaveAttribute("href", "https://aistudio.google.com");
      expect(signupLink).toHaveAttribute("target", "_blank");
    });
  });

  describe("with configured providers", () => {
    const configuredProviders = {
      anthropic: { configured: true, hint: "xY9z" },
      openai: { configured: false },
      google: { configured: false },
    };

    it("should show 'Configured' indicator when configuredProviders marks a provider as configured", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      expect(screen.getByText("Configured")).toBeInTheDocument();
    });

    it("should show 'Active' indicator for the defaultProvider", () => {
      render(
        <ProviderKeyForm
          onSuccess={onSuccess}
          configuredProviders={configuredProviders}
          defaultProvider="anthropic"
        />
      );

      expect(screen.getByText("Active")).toBeInTheDocument();
    });

    it("should always show input with masked placeholder for configured provider", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));

      expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText("sk-ant-····xY9z")).toBeInTheDocument();
    });

    it("should show configured indicator when configured provider is selected", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));

      expect(screen.getByTestId("key-configured-indicator")).toBeInTheDocument();
    });

    it("should not show configured indicator when unconfigured provider is selected", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /openai/i }));

      expect(screen.queryByTestId("key-configured-indicator")).not.toBeInTheDocument();
    });

    it("should show normal placeholder for unconfigured provider", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /openai/i }));

      expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText("sk-...")).toBeInTheDocument();
    });

    it("should not show status indicators without configuredProviders prop", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} />);

      expect(screen.queryByText("Configured")).not.toBeInTheDocument();
      expect(screen.queryByText("Active")).not.toBeInTheDocument();
    });

    it("should show error indicator instead of configured indicator on failed save", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Invalid API key." }),
      } as Response);

      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
      fireEvent.change(screen.getByLabelText(/api key/i), {
        target: { value: "sk-ant-bad-key" },
      });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByTestId("key-error-indicator")).toBeInTheDocument();
        expect(screen.queryByTestId("key-configured-indicator")).not.toBeInTheDocument();
      });
    });

    it("should show configured indicator after successful save", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /openai/i }));
      fireEvent.change(screen.getByLabelText(/api key/i), {
        target: { value: "sk-new-key" },
      });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByTestId("key-configured-indicator")).toBeInTheDocument();
      });
    });

    it("should show 'Remove key' button when configured provider is selected", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));

      expect(screen.getByRole("button", { name: /remove key/i })).toBeInTheDocument();
    });

    it("should not show 'Remove key' button for unconfigured provider", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /openai/i }));

      expect(screen.queryByRole("button", { name: /remove key/i })).not.toBeInTheDocument();
    });

    it("should not show 'Remove key' button in setup wizard mode", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));

      expect(screen.queryByRole("button", { name: /remove key/i })).not.toBeInTheDocument();
    });

    it("should call DELETE endpoint and onSuccess after successful removal", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
      fireEvent.click(screen.getByRole("button", { name: /remove key/i }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/settings/providers", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "anthropic" }),
        });
        expect(onSuccess).toHaveBeenCalled();
      });
    });

    it("should show error when trying to remove the last configured provider", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: "Cannot remove the last configured provider. Add another provider first.",
        }),
      } as Response);

      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
      fireEvent.click(screen.getByRole("button", { name: /remove key/i }));

      await waitFor(() => {
        expect(screen.getByText(/cannot remove the last configured provider/i)).toBeInTheDocument();
      });
    });
  });
});
