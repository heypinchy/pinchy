import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { WebSearchPermissionSection } from "@/components/web-search-permission-section";

describe("WebSearchPermissionSection", () => {
  const defaultProps = {
    config: {},
    onChange: vi.fn(),
    showSecurityWarning: false,
    hasApiKey: true,
  };

  it("renders allowed domains and excluded domains inputs", () => {
    render(<WebSearchPermissionSection {...defaultProps} />);

    expect(screen.getByLabelText("Allowed Domains")).toBeInTheDocument();
    expect(screen.getByLabelText("Excluded Domains")).toBeInTheDocument();
  });

  it("renders freshness, language, and region dropdowns", () => {
    render(<WebSearchPermissionSection {...defaultProps} />);

    expect(screen.getByLabelText("Freshness")).toBeInTheDocument();
    expect(screen.getByLabelText("Language")).toBeInTheDocument();
    expect(screen.getByLabelText("Region")).toBeInTheDocument();
  });

  it("can add a domain tag to allowed domains", async () => {
    const onChange = vi.fn();
    render(<WebSearchPermissionSection {...defaultProps} onChange={onChange} />);

    const input = screen.getByLabelText("Allowed Domains");
    await userEvent.type(input, "example.com{Enter}");

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDomains: ["example.com"] })
    );
  });

  it("can remove a domain tag from allowed domains", async () => {
    const onChange = vi.fn();
    render(
      <WebSearchPermissionSection
        {...defaultProps}
        config={{ allowedDomains: ["example.com", "test.com"] }}
        onChange={onChange}
      />
    );

    // Both tags should be visible
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("test.com")).toBeInTheDocument();

    // Remove the first one
    const removeButtons = screen.getAllByLabelText(/^Remove /);
    await userEvent.click(removeButtons[0]);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDomains: ["test.com"] })
    );
  });

  it("can add a domain tag to excluded domains", async () => {
    const onChange = vi.fn();
    render(<WebSearchPermissionSection {...defaultProps} onChange={onChange} />);

    const input = screen.getByLabelText("Excluded Domains");
    await userEvent.type(input, "bad.com{Enter}");

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ excludedDomains: ["bad.com"] })
    );
  });

  it("can remove a domain tag from excluded domains", async () => {
    const onChange = vi.fn();
    render(
      <WebSearchPermissionSection
        {...defaultProps}
        config={{ excludedDomains: ["bad.com", "spam.com"] }}
        onChange={onChange}
      />
    );

    expect(screen.getByText("bad.com")).toBeInTheDocument();
    expect(screen.getByText("spam.com")).toBeInTheDocument();

    // Remove buttons for excluded domains (after any allowed domain remove buttons)
    const removeButtons = screen.getAllByLabelText(/^Remove /);
    await userEvent.click(removeButtons[0]);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ excludedDomains: ["spam.com"] })
    );
  });

  it("does not add duplicate domains", async () => {
    const onChange = vi.fn();
    render(
      <WebSearchPermissionSection
        {...defaultProps}
        config={{ allowedDomains: ["example.com"] }}
        onChange={onChange}
      />
    );

    const input = screen.getByLabelText("Allowed Domains");
    await userEvent.type(input, "example.com{Enter}");

    // onChange should never have been called with a duplicate entry
    const allCalls = onChange.mock.calls;
    for (const call of allCalls) {
      const domains = call[0]?.allowedDomains;
      if (domains) {
        expect(new Set(domains).size).toBe(domains.length);
      }
    }
  });

  it("shows info banner when hasApiKey is false", () => {
    render(<WebSearchPermissionSection {...defaultProps} hasApiKey={false} />);

    expect(screen.getByText(/web search requires a Brave Search API key/i)).toBeInTheDocument();
  });

  it("does not show info banner when hasApiKey is true", () => {
    render(<WebSearchPermissionSection {...defaultProps} hasApiKey={true} />);

    expect(
      screen.queryByText(/web search requires a Brave Search API key/i)
    ).not.toBeInTheDocument();
  });

  it("shows security warning when showSecurityWarning is true", () => {
    render(<WebSearchPermissionSection {...defaultProps} showSecurityWarning={true} />);

    expect(
      screen.getByText(/malicious web content could attempt to extract data/i)
    ).toBeInTheDocument();
  });

  it("hides security warning when showSecurityWarning is false", () => {
    render(<WebSearchPermissionSection {...defaultProps} showSecurityWarning={false} />);

    expect(
      screen.queryByText(/malicious web content could attempt to extract data/i)
    ).not.toBeInTheDocument();
  });

  it("renders existing config values as tags", () => {
    render(
      <WebSearchPermissionSection
        {...defaultProps}
        config={{
          allowedDomains: ["docs.example.com"],
          excludedDomains: ["spam.net"],
        }}
      />
    );

    expect(screen.getByText("docs.example.com")).toBeInTheDocument();
    expect(screen.getByText("spam.net")).toBeInTheDocument();
  });

  it("clears input after adding a domain", async () => {
    render(<WebSearchPermissionSection {...defaultProps} />);

    const input = screen.getByLabelText("Allowed Domains");
    await userEvent.type(input, "example.com{Enter}");

    expect(input).toHaveValue("");
  });

  it("does not add a domain with invalid format (special chars)", async () => {
    const onChange = vi.fn();
    render(<WebSearchPermissionSection {...defaultProps} onChange={onChange} />);

    const input = screen.getByLabelText("Allowed Domains");
    await userEvent.type(input, "not a domain!!!{Enter}");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not add a bare word without a dot", async () => {
    const onChange = vi.fn();
    render(<WebSearchPermissionSection {...defaultProps} onChange={onChange} />);

    const input = screen.getByLabelText("Allowed Domains");
    await userEvent.type(input, "localhost{Enter}");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not add an empty string as a domain", async () => {
    const onChange = vi.fn();
    render(<WebSearchPermissionSection {...defaultProps} onChange={onChange} />);

    const input = screen.getByLabelText("Allowed Domains");
    await userEvent.type(input, "{Enter}");

    expect(onChange).not.toHaveBeenCalled();
  });
});
