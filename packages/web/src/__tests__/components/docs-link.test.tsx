import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { existsSync } from "fs";
import { resolve } from "path";
import { DocsLink, DOCS_BASE_URL, docsUrl } from "@/components/docs-link";
import { DOCS_PATHS } from "@/lib/docs-paths.generated";

describe("DocsLink", () => {
  it("renders a link with the correct URL", () => {
    render(<DocsLink path="guides/mount-data-directories">Mount data</DocsLink>);
    const link = screen.getByRole("link", { name: /mount data/i });
    expect(link).toHaveAttribute("href", `${DOCS_BASE_URL}/guides/mount-data-directories/`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders children as link text", () => {
    render(<DocsLink path="guides/create-knowledge-base-agent">KB guide</DocsLink>);
    expect(screen.getByText("KB guide")).toBeInTheDocument();
  });

  it("appends hash fragment when provided", () => {
    render(
      <DocsLink path="guides/vps-deployment" hash="set-up-https-with-caddy">
        HTTPS setup
      </DocsLink>
    );
    const link = screen.getByRole("link", { name: /https setup/i });
    expect(link).toHaveAttribute(
      "href",
      `${DOCS_BASE_URL}/guides/vps-deployment/#set-up-https-with-caddy`
    );
  });
});

describe("docsUrl", () => {
  it("returns full URL for a docs path", () => {
    expect(docsUrl("guides/domain-lock")).toBe(`${DOCS_BASE_URL}/guides/domain-lock/`);
  });

  it("appends hash fragment", () => {
    expect(docsUrl("guides/vps-deployment", "set-up-https-with-caddy")).toBe(
      `${DOCS_BASE_URL}/guides/vps-deployment/#set-up-https-with-caddy`
    );
  });
});

describe("generated docs paths match actual files", () => {
  const docsContentDir = resolve(__dirname, "../../../../../docs/src/content/docs");

  for (const docPath of DOCS_PATHS) {
    it(`docs page exists: ${docPath}`, () => {
      const mdxPath = resolve(docsContentDir, `${docPath}.mdx`);
      const mdPath = resolve(docsContentDir, `${docPath}.md`);
      const exists = existsSync(mdxPath) || existsSync(mdPath);
      expect(
        exists,
        `Documentation page not found: ${docPath}. Expected at ${mdxPath} or ${mdPath}. Run 'pnpm docs:paths' to regenerate.`
      ).toBe(true);
    });
  }
});
