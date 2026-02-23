import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { existsSync } from "fs";
import { resolve } from "path";
import { DocsLink, DOCS_BASE_URL } from "@/components/docs-link";

describe("DocsLink", () => {
  it("should render a link with the correct URL", () => {
    render(<DocsLink path="guides/mount-data-directories">Mount data</DocsLink>);
    const link = screen.getByRole("link", { name: /mount data/i });
    expect(link).toHaveAttribute("href", `${DOCS_BASE_URL}/guides/mount-data-directories/`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("should render children as link text", () => {
    render(<DocsLink path="guides/create-knowledge-base-agent">KB guide</DocsLink>);
    expect(screen.getByText("KB guide")).toBeInTheDocument();
  });
});

describe("DocsLink path validation", () => {
  const docsContentDir = resolve(__dirname, "../../../../../docs/src/content/docs");

  const usedPaths = [
    "guides/mount-data-directories",
    "guides/create-knowledge-base-agent",
  ];

  for (const docPath of usedPaths) {
    it(`docs page exists: ${docPath}`, () => {
      const mdxPath = resolve(docsContentDir, `${docPath}.mdx`);
      const mdPath = resolve(docsContentDir, `${docPath}.md`);
      const exists = existsSync(mdxPath) || existsSync(mdPath);
      expect(
        exists,
        `Documentation page not found: ${docPath}. Expected at ${mdxPath} or ${mdPath}`
      ).toBe(true);
    });
  }
});
