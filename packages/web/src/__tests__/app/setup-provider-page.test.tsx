import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import SetupProviderPage from "@/app/setup/provider/page";
import type { ProviderName } from "@/lib/providers";

const pushMock = vi.fn();

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
  ProviderKeyForm: ({ onSuccess }: { onSuccess: (provider?: ProviderName) => void }) => {
    capturedOnSuccess = onSuccess;
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
  });

  it("should render the Pinchy logo", () => {
    render(<SetupProviderPage />);
    const logo = screen.getByAltText("Pinchy");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "/pinchy-logo.png");
  });

  it("should display page title", () => {
    render(<SetupProviderPage />);
    expect(screen.getByText("Connect your AI provider")).toBeInTheDocument();
  });

  it("should display page description", () => {
    render(<SetupProviderPage />);
    expect(
      screen.getByText(/choose your llm provider and enter your api key/i)
    ).toBeInTheDocument();
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
});
