import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { MarkdownEditor } from "@/components/markdown-editor";

vi.mock("prismjs", () => ({
  default: {
    highlight: vi.fn((code: string) => code),
    languages: { markdown: {} },
  },
}));

vi.mock("prismjs/components/prism-markdown", () => ({}));

describe("MarkdownEditor", () => {
  it("renders with the provided value", () => {
    render(<MarkdownEditor value="# Hello" onChange={() => {}} />);

    expect(screen.getByRole("textbox")).toHaveValue("# Hello");
  });

  it("calls onChange when text is entered", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="" onChange={onChange} />);

    await userEvent.type(screen.getByRole("textbox"), "x");

    expect(onChange).toHaveBeenCalledWith("x");
  });

  it("applies custom className", () => {
    const { container } = render(
      <MarkdownEditor value="" onChange={() => {}} className="min-h-[300px]" />
    );

    expect(container.firstChild).toHaveClass("min-h-[300px]");
  });
});
