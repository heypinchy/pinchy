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

  describe("empty state", () => {
    it("shows unrestricted-access message and Add restriction button when no domains are set", () => {
      render(<WebSearchPermissionSection {...defaultProps} />);

      expect(screen.getByText(/this agent can browse the entire web/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /add restriction/i })).toBeInTheDocument();
      expect(screen.queryByLabelText("Add domain")).not.toBeInTheDocument();
    });

    it("reveals the domain input after clicking Add restriction", async () => {
      render(<WebSearchPermissionSection {...defaultProps} />);

      await userEvent.click(screen.getByRole("button", { name: /add restriction/i }));

      expect(screen.getByLabelText("Add domain")).toBeInTheDocument();
    });

    it("renders the input directly (no empty state) when domains already exist", () => {
      render(
        <WebSearchPermissionSection
          {...defaultProps}
          config={{ allowedDomains: ["example.com"] }}
        />
      );

      expect(screen.getByLabelText("Add domain")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /add restriction/i })).not.toBeInTheDocument();
    });
  });

  describe("adding domains", () => {
    async function expandInput() {
      await userEvent.click(screen.getByRole("button", { name: /add restriction/i }));
    }

    it("adds an Include domain to allowedDomains by default", async () => {
      const onChange = vi.fn();
      render(<WebSearchPermissionSection {...defaultProps} onChange={onChange} />);
      await expandInput();

      await userEvent.type(screen.getByLabelText("Add domain"), "example.com{Enter}");

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ allowedDomains: ["example.com"] })
      );
    });

    it("adds a domain when the Add button is clicked", async () => {
      const onChange = vi.fn();
      render(<WebSearchPermissionSection {...defaultProps} onChange={onChange} />);
      await expandInput();

      await userEvent.type(screen.getByLabelText("Add domain"), "example.com");
      await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ allowedDomains: ["example.com"] })
      );
    });

    it("disables the Add button when input is empty", async () => {
      render(<WebSearchPermissionSection {...defaultProps} />);
      await expandInput();

      expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled();
    });

    it("adds to excludedDomains when mode is switched to Exclude", async () => {
      const onChange = vi.fn();
      render(<WebSearchPermissionSection {...defaultProps} onChange={onChange} />);
      await expandInput();

      await userEvent.click(screen.getByRole("radio", { name: /exclude/i }));
      await userEvent.type(screen.getByLabelText("Add domain"), "bad.com{Enter}");

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ excludedDomains: ["bad.com"] })
      );
    });

    it("clears the input after adding a domain", async () => {
      render(<WebSearchPermissionSection {...defaultProps} />);
      await expandInput();

      const input = screen.getByLabelText("Add domain");
      await userEvent.type(input, "example.com{Enter}");

      expect(input).toHaveValue("");
    });

    it("rejects invalid domains", async () => {
      const onChange = vi.fn();
      render(<WebSearchPermissionSection {...defaultProps} onChange={onChange} />);
      await expandInput();

      await userEvent.type(screen.getByLabelText("Add domain"), "not a domain!!!{Enter}");

      expect(onChange).not.toHaveBeenCalled();
    });

    it("rejects bare words without a dot", async () => {
      const onChange = vi.fn();
      render(<WebSearchPermissionSection {...defaultProps} onChange={onChange} />);
      await expandInput();

      await userEvent.type(screen.getByLabelText("Add domain"), "localhost{Enter}");

      expect(onChange).not.toHaveBeenCalled();
    });

    it("does not add duplicates across both lists", async () => {
      const onChange = vi.fn();
      render(
        <WebSearchPermissionSection
          {...defaultProps}
          config={{ allowedDomains: ["example.com"] }}
          onChange={onChange}
        />
      );

      await userEvent.type(screen.getByLabelText("Add domain"), "example.com{Enter}");

      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe("restriction scope hint", () => {
    it("clarifies that restrictions apply to both tools", () => {
      render(<WebSearchPermissionSection {...defaultProps} />);
      expect(screen.getByText(/applies to both tools/i)).toBeInTheDocument();
    });
  });

  describe("chip display and interaction", () => {
    it("renders allowed domains as Include chips and excluded as Exclude chips", () => {
      render(
        <WebSearchPermissionSection
          {...defaultProps}
          config={{
            allowedDomains: ["docs.example.com"],
            excludedDomains: ["spam.net"],
          }}
        />
      );

      const allowedChip = screen.getByText("docs.example.com").closest("[data-chip-mode]");
      const excludedChip = screen.getByText("spam.net").closest("[data-chip-mode]");
      expect(allowedChip).toHaveAttribute("data-chip-mode", "include");
      expect(excludedChip).toHaveAttribute("data-chip-mode", "exclude");
    });

    it("has an explanatory title tooltip on each chip", () => {
      render(
        <WebSearchPermissionSection
          {...defaultProps}
          config={{
            allowedDomains: ["good.com"],
            excludedDomains: ["bad.com"],
          }}
        />
      );

      const includeChip = screen.getByText("good.com").closest("[data-chip-mode]");
      const excludeChip = screen.getByText("bad.com").closest("[data-chip-mode]");
      expect(includeChip).toHaveAttribute("title", expect.stringMatching(/allowed to access/i));
      expect(excludeChip).toHaveAttribute("title", expect.stringMatching(/blocked/i));
    });

    it("has a title tooltip hinting that the mode button toggles", () => {
      render(
        <WebSearchPermissionSection
          {...defaultProps}
          config={{ allowedDomains: ["example.com"] }}
        />
      );

      expect(screen.getByLabelText("Toggle example.com to Exclude")).toHaveAttribute(
        "title",
        expect.stringMatching(/switch to exclude/i)
      );
    });

    it("removes a chip when its X button is clicked", async () => {
      const onChange = vi.fn();
      render(
        <WebSearchPermissionSection
          {...defaultProps}
          config={{ allowedDomains: ["example.com", "test.com"] }}
          onChange={onChange}
        />
      );

      await userEvent.click(screen.getByLabelText("Remove example.com"));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ allowedDomains: ["test.com"] })
      );
    });

    it("toggles a chip from Include to Exclude when the mode button is clicked", async () => {
      const onChange = vi.fn();
      render(
        <WebSearchPermissionSection
          {...defaultProps}
          config={{ allowedDomains: ["example.com"], excludedDomains: [] }}
          onChange={onChange}
        />
      );

      await userEvent.click(screen.getByLabelText("Toggle example.com to Exclude"));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedDomains: [],
          excludedDomains: ["example.com"],
        })
      );
    });

    it("toggles a chip from Exclude to Include when the mode button is clicked", async () => {
      const onChange = vi.fn();
      render(
        <WebSearchPermissionSection
          {...defaultProps}
          config={{ allowedDomains: [], excludedDomains: ["bad.com"] }}
          onChange={onChange}
        />
      );

      await userEvent.click(screen.getByLabelText("Toggle bad.com to Include"));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedDomains: ["bad.com"],
          excludedDomains: [],
        })
      );
    });
  });

  describe("advanced options", () => {
    it("hides Freshness, Language, and Region by default", () => {
      render(<WebSearchPermissionSection {...defaultProps} />);

      const trigger = screen.getByRole("button", { name: /advanced options/i });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });

    it("shows Freshness, Language, and Region after expanding", async () => {
      render(<WebSearchPermissionSection {...defaultProps} />);

      await userEvent.click(screen.getByRole("button", { name: /advanced options/i }));

      expect(screen.getByLabelText("Freshness")).toBeInTheDocument();
      expect(screen.getByLabelText("Language")).toBeInTheDocument();
      expect(screen.getByLabelText("Region")).toBeInTheDocument();
    });
  });

  describe("banners", () => {
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
  });
});
