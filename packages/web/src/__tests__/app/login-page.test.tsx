import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import LoginPage from "@/app/login/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
}));

vi.mock("next/image", () => ({
  default: ({ priority, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

describe("Login Page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should render the Pinchy logo", () => {
    render(<LoginPage />);
    const logo = screen.getByAltText("Pinchy");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "/pinchy-logo.png");
  });

  it("should display 'Sign in to Pinchy' as title", () => {
    render(<LoginPage />);
    expect(screen.getByText("Sign in to Pinchy")).toBeInTheDocument();
  });

  it("should display login description", () => {
    render(<LoginPage />);
    expect(
      screen.getByText(
        "Enter the credentials you created during setup."
      )
    ).toBeInTheDocument();
  });

  it("should render email and password fields", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("should have a 'Sign in' button", () => {
    render(<LoginPage />);
    expect(
      screen.getByRole("button", { name: /sign in/i })
    ).toBeInTheDocument();
  });
});
