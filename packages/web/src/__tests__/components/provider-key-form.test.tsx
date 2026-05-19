// packages/web/src/__tests__/components/provider-key-form.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ProviderKeyForm } from "@/components/provider-key-form";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/github-issue", () => ({
  buildGitHubIssueUrl: vi.fn().mockReturnValue("https://github.com/test"),
  fetchDiagnostics: vi.fn().mockResolvedValue(null),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/setup/provider",
}));

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

  it("should render five provider buttons", () => {
    render(<ProviderKeyForm onSuccess={onSuccess} />);

    expect(screen.getByRole("button", { name: /anthropic/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /openai/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ollama cloud/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ollama \(local\)/i })).toBeInTheDocument();
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

  it("should call onSuccess and show success toast after successful submission", async () => {
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
      expect(toast.success).toHaveBeenCalledWith("API key saved");
    });
  });

  it("should show inline error message on failed validation", async () => {
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
      expect(screen.getByText("Invalid API key. Please check and try again.")).toBeInTheDocument();
    });
  });

  it("should show report issue link on failed validation", async () => {
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
      expect(screen.getByRole("button", { name: /report this issue/i })).toBeInTheDocument();
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

    await waitFor(() => {
      expect(screen.getByText(/validating/i)).toBeInTheDocument();
    });
  });

  it("should use custom submitLabel", () => {
    render(<ProviderKeyForm onSuccess={onSuccess} submitLabel="Save" />);

    fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: "sk-ant-key" },
    });

    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  describe("onDirtyChange callback", () => {
    it("should call onDirtyChange(true) when provider is selected and API key is typed", () => {
      const onDirtyChange = vi.fn();
      render(<ProviderKeyForm onSuccess={onSuccess} onDirtyChange={onDirtyChange} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
      fireEvent.change(screen.getByLabelText(/api key/i), {
        target: { value: "sk-ant-somekey" },
      });

      expect(onDirtyChange).toHaveBeenCalledWith(true);
    });

    it("should call onDirtyChange(false) after successful save", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      const onDirtyChange = vi.fn();
      render(<ProviderKeyForm onSuccess={onSuccess} onDirtyChange={onDirtyChange} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
      fireEvent.change(screen.getByLabelText(/api key/i), {
        target: { value: "sk-ant-somekey" },
      });
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));

      await waitFor(() => {
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
      });
    });
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
        expect(screen.getByText("Invalid API key.")).toBeInTheDocument();
      });
    });

    it("should show configured indicator and success toast after successful save", async () => {
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
        expect(toast.success).toHaveBeenCalledWith("API key saved");
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

    it("should open confirmation dialog when Remove key is clicked", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
      fireEvent.click(screen.getByRole("button", { name: /remove key/i }));

      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
      expect(screen.getByText("Remove API key?")).toBeInTheDocument();
    });

    it("should not call DELETE when Cancel is clicked in confirmation dialog", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
      fireEvent.click(screen.getByRole("button", { name: /remove key/i }));
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should call DELETE endpoint and onSuccess after confirming removal", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
      fireEvent.click(screen.getByRole("button", { name: /remove key/i }));
      fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/settings/providers", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "anthropic" }),
        });
        expect(onSuccess).toHaveBeenCalled();
      });
    });

    it("should show error toast when trying to remove the last configured provider", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: "Cannot remove the last configured provider. Add another provider first.",
        }),
      } as Response);

      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
      fireEvent.click(screen.getByRole("button", { name: /remove key/i }));
      fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          "Cannot remove the last configured provider. Add another provider first."
        );
      });
    });
  });

  // #296 review follow-up — when the route returns structured `docs`
  // metadata (currently only for `unsupported_local_host`), the form should
  // render a clickable <a> next to the inline error instead of forcing the
  // user to copy a URL from prose text. The prose itself stays plain (no
  // long URL squashed in), and the link opens in a new tab.
  describe("structured docs hint on error (#296)", () => {
    const unsupportedHostResponse = {
      ok: false,
      json: async () => ({
        error: 'Host "ollama" is not an allowed local Ollama host. Use localhost, ...',
        docs: {
          href: "https://docs.heypinchy.com/guides/ollama-setup/#b-ollama-as-a-docker-service",
          label: "See the recommended Docker setup",
        },
      }),
    } as Response;

    async function submitOllamaLocal() {
      fireEvent.click(screen.getByRole("button", { name: /ollama \(local\)/i }));
      fireEvent.change(screen.getByLabelText(/ollama url/i), {
        target: { value: "http://ollama:11434" },
      });
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    }

    it("renders the docs hint as a clickable anchor with the structured href and label", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(unsupportedHostResponse);

      render(<ProviderKeyForm onSuccess={onSuccess} />);
      await submitOllamaLocal();

      const link = await screen.findByRole("link", { name: /see the recommended docker setup/i });
      expect(link).toHaveAttribute(
        "href",
        "https://docs.heypinchy.com/guides/ollama-setup/#b-ollama-as-a-docker-service"
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    });

    it("shows the plain error text without the URL embedded inline", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(unsupportedHostResponse);

      render(<ProviderKeyForm onSuccess={onSuccess} />);
      await submitOllamaLocal();

      // The visible error prose must not contain "http" — the URL belongs in
      // the anchor, not squashed into the sentence.
      const errorText = await screen.findByText(/is not an allowed local ollama host/i);
      expect(errorText.textContent).not.toMatch(/https?:\/\//);
    });

    it("does not render a docs link inside the error region when the response has no docs field", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Could not connect to Ollama at this URL." }),
      } as Response);

      render(<ProviderKeyForm onSuccess={onSuccess} />);
      await submitOllamaLocal();

      // Scope the assertion to the error region itself rather than relying on
      // the collapsed-Collapsible side-effect from elsewhere in the form.
      // The error text lives in a `<div className="space-y-1">` that also
      // holds the optional docs anchor — so the closest <div> ancestor is
      // exactly the region we care about. If a future change ever renders
      // an unrelated link inside that region, this test catches it.
      const errorText = await screen.findByText(/could not connect to ollama/i);
      const errorRegion = errorText.closest("div");
      expect(errorRegion).not.toBeNull();
      expect(errorRegion!.querySelector("a")).toBeNull();
    });

    it("clears the docs link when switching providers", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(unsupportedHostResponse);

      render(<ProviderKeyForm onSuccess={onSuccess} />);
      await submitOllamaLocal();

      await screen.findByRole("link", { name: /see the recommended docker setup/i });

      // Switching to a different provider resets all error state — including
      // the docs hint — so stale hints don't bleed across providers.
      fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));

      expect(
        screen.queryByRole("link", { name: /see the recommended docker setup/i })
      ).not.toBeInTheDocument();
    });

    // Regression guard: if a future refactor drops the `setErrorDocs(null)`
    // at the start of onSubmit, two consecutive errors would leave the first
    // submission's docs link hanging next to the second submission's error
    // prose. That's worse than no link at all — it points users at a fix
    // that doesn't match the current error.
    it("clears a previously-shown docs link when the next error response has no docs", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(unsupportedHostResponse)
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({ error: "Could not connect to Ollama at this URL." }),
        } as Response);

      render(<ProviderKeyForm onSuccess={onSuccess} />);
      await submitOllamaLocal();
      await screen.findByRole("link", { name: /see the recommended docker setup/i });

      // Second submit — same provider, different error, no docs field.
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));

      await screen.findByText(/could not connect to ollama/i);
      expect(
        screen.queryByRole("link", { name: /see the recommended docker setup/i })
      ).not.toBeInTheDocument();
    });

    // Security hardening: even if the route is ever compromised or a future
    // route forwards user input into the `docs` field, the client must not
    // render a `javascript:` URL as a clickable anchor. The defensive parse
    // requires the href to start with http(s):// — anything else falls back
    // to the plain error prose with no link.
    it("rejects a docs.href that is not a http(s) URL (e.g. javascript: scheme)", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: 'Host "ollama" is not an allowed local Ollama host.',
          docs: {
            href: "javascript:alert(1)",
            label: "See the recommended Docker setup",
          },
        }),
      } as Response);

      render(<ProviderKeyForm onSuccess={onSuccess} />);
      await submitOllamaLocal();

      await screen.findByText(/is not an allowed local ollama host/i);
      // No anchor at all — neither the malicious href nor any fallback.
      expect(
        screen.queryByRole("link", { name: /see the recommended docker setup/i })
      ).not.toBeInTheDocument();
    });

    // Belt-and-braces: an empty label would render an anchor that's just the
    // ExternalLink icon — a click target with no visible text. Treat it the
    // same as a missing docs field.
    it("rejects a docs.label that is an empty string", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: 'Host "ollama" is not an allowed local Ollama host.',
          docs: {
            href: "https://docs.heypinchy.com/guides/ollama-setup/",
            label: "",
          },
        }),
      } as Response);

      render(<ProviderKeyForm onSuccess={onSuccess} />);
      await submitOllamaLocal();

      const errorText = await screen.findByText(/is not an allowed local ollama host/i);
      const errorRegion = errorText.closest("div");
      expect(errorRegion).not.toBeNull();
      expect(errorRegion!.querySelector("a")).toBeNull();
    });
  });

  describe("URL-based provider (ollama-local)", () => {
    it("should show 'Ollama URL' label instead of 'API Key' when ollama-local is selected", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /ollama \(local\)/i }));

      expect(screen.getByLabelText(/ollama url/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
    });

    it("should show text input instead of password input for URL providers", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /ollama \(local\)/i }));

      const input = screen.getByLabelText(/ollama url/i);
      expect(input).toHaveAttribute("type", "text");
    });

    it("should show URL-specific help text instead of encryption hint", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /ollama \(local\)/i }));

      expect(screen.getByText(/your url is stored on your server/i)).toBeInTheDocument();
      expect(screen.queryByText(/encrypted at rest/i)).not.toBeInTheDocument();
    });

    it("should send url field instead of apiKey for URL providers", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /ollama \(local\)/i }));
      fireEvent.change(screen.getByLabelText(/ollama url/i), {
        target: { value: "http://host.docker.internal:11434" },
      });
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/setup/provider", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "ollama-local",
            url: "http://host.docker.internal:11434",
          }),
        });
      });
    });

    it("should show success toast with 'URL saved' for URL providers", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);

      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /ollama \(local\)/i }));
      fireEvent.change(screen.getByLabelText(/ollama url/i), {
        target: { value: "http://host.docker.internal:11434" },
      });
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith("URL saved");
      });
    });

    it("should show 'Remove URL' button for configured URL providers", () => {
      const configuredProviders = {
        "ollama-local": { configured: true, hint: "1434" },
      };

      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /ollama \(local\)/i }));

      expect(screen.getByRole("button", { name: /remove url/i })).toBeInTheDocument();
    });

    it("should show 'Remove URL?' in confirmation dialog for URL providers", () => {
      const configuredProviders = {
        "ollama-local": { configured: true, hint: "1434" },
      };

      render(<ProviderKeyForm onSuccess={onSuccess} configuredProviders={configuredProviders} />);

      fireEvent.click(screen.getByRole("button", { name: /ollama \(local\)/i }));
      fireEvent.click(screen.getByRole("button", { name: /remove url/i }));

      expect(screen.getByText("Remove URL?")).toBeInTheDocument();
    });

    it("should show help guide text appropriate for URL providers", () => {
      render(<ProviderKeyForm onSuccess={onSuccess} />);

      fireEvent.click(screen.getByRole("button", { name: /ollama \(local\)/i }));
      fireEvent.click(screen.getByText(/need help/i));

      expect(screen.getByText(/install ollama/i)).toBeInTheDocument();
      expect(screen.getByText(/pull a model/i)).toBeInTheDocument();
    });
  });
});
