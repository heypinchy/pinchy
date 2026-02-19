import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import SetupProviderPage from "@/app/setup/provider/page";

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

vi.mock("@/components/provider-key-form", () => ({
  ProviderKeyForm: ({ onSuccess }: { onSuccess: () => void }) => (
    <button onClick={onSuccess} data-testid="mock-provider-form">
      MockProviderForm
    </button>
  ),
}));

describe("Setup Provider Page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("should redirect to home on success", () => {
    render(<SetupProviderPage />);
    fireEvent.click(screen.getByTestId("mock-provider-form"));
    expect(pushMock).toHaveBeenCalledWith("/");
  });
});
