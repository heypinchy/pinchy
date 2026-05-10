import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import "@testing-library/jest-dom";

// Shared mutable state for the assistant-ui hooks. Tests flip these fields
// before rendering to exercise composer-vs-thread, image-vs-document, and
// short-vs-long-filename paths.
const auiState = vi.hoisted(() => ({
  source: "composer" as "composer" | "thread",
  type: "document" as "image" | "document" | "file",
  name: "invoice.pdf" as string | undefined,
}));

vi.mock("@assistant-ui/react", () => ({
  AttachmentPrimitive: {
    Root: ({
      children,
      className,
      ...rest
    }: {
      children?: React.ReactNode;
      className?: string;
      [k: string]: unknown;
    }) => (
      <div data-testid="attachment-root" className={className} {...rest}>
        {children}
      </div>
    ),
    Name: () => <span data-testid="aui-attachment-name">{auiState.name ?? "File"}</span>,
    Remove: ({ children, asChild }: { children?: React.ReactNode; asChild?: boolean }) => {
      if (asChild && React.isValidElement(children)) {
        // Mirror @assistant-ui's slot behaviour: forward the trigger props to
        // the child element so the test can find the button by aria-label.
        return React.cloneElement(children as React.ReactElement<Record<string, unknown>>);
      }
      return <button aria-label="Remove file">{children}</button>;
    },
  },
  MessagePrimitive: { Attachments: () => null },
  ComposerPrimitive: { Attachments: () => null, AddAttachment: () => null },
  useAui: () => ({ attachment: { source: auiState.source } }),
  useAuiState: <T,>(selector: (s: { attachment: typeof auiState }) => T): T =>
    selector({ attachment: auiState }),
}));

// useShallow normally memoizes; for tests we just pass the selector through —
// useAuiState is mocked above and calls the selector directly.
vi.mock("zustand/shallow", () => ({
  useShallow: <T,>(fn: T) => fn,
}));

// cn is a simple class-name joiner; the real implementation pulls in tailwind-merge
// which is irrelevant here.
vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// Pass-through mocks for the UI primitives used inside the tooltip/thumbnail
// branch of AttachmentUI. Only the composer-chip branch is under test here.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children, asChild }: { children?: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  DialogTrigger: ({ children, asChild }: { children?: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
}));
vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  AvatarFallback: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  AvatarImage: ({ src, alt }: { src?: string; alt?: string }) => <img src={src} alt={alt ?? ""} />,
}));
vi.mock("@/components/assistant-ui/tooltip-icon-button", () => ({
  TooltipIconButton: ({
    children,
    ...rest
  }: {
    children?: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <button aria-label="Remove file" {...rest}>
      {children}
    </button>
  ),
}));

describe("Composer chip — non-image (PDF)", () => {
  beforeEach(() => {
    auiState.source = "composer";
    auiState.type = "document";
    auiState.name = "invoice.pdf";
  });

  it("renders the filename split into base + extension so both are always present in the DOM", async () => {
    const { AttachmentUI } = await import("@/components/assistant-ui/attachment");
    render(<AttachmentUI />);
    expect(screen.getByText("invoice")).toBeInTheDocument();
    expect(screen.getByText(".pdf")).toBeInTheDocument();
  });

  it("renders the file extension in a non-truncating span so it stays visible on long filenames", async () => {
    // Real-world UUID-style upload name — the user reported this rendered as
    // "pb17780468186..." with the extension hidden. The chip MUST split the
    // name so the extension keeps its own non-truncating span.
    auiState.name = "pb17780468186abcdefghijklmnopqrstuvwxyz0123456789.pdf";
    const { AttachmentUI } = await import("@/components/assistant-ui/attachment");
    render(<AttachmentUI />);

    const ext = screen.getByText(".pdf");
    // The extension span must not collapse — otherwise the truncation eats it.
    expect(ext.className).toContain("shrink-0");
    expect(ext.className).not.toContain("truncate");

    // And the base name span must truncate (the failure mode is base also being
    // shrink-0, which would overflow the chip).
    const base = screen.getByText(/^pb17780468186abcdef/);
    expect(base.className).toContain("truncate");
  });

  it("exposes the full filename via a title attribute on the chip so hovering reveals it", async () => {
    auiState.name = "very-long-quarterly-financial-report-2026-q1-final.pdf";
    const { AttachmentUI } = await import("@/components/assistant-ui/attachment");
    const { container } = render(<AttachmentUI />);
    const titled = container.querySelector(
      '[title="very-long-quarterly-financial-report-2026-q1-final.pdf"]'
    );
    expect(titled).not.toBeNull();
  });

  it("falls back to base = full name + empty extension when the filename has no dot", async () => {
    // Defensive: don't crash on filenames without an extension (e.g. "README").
    auiState.name = "README";
    const { AttachmentUI } = await import("@/components/assistant-ui/attachment");
    render(<AttachmentUI />);
    expect(screen.getByText("README")).toBeInTheDocument();
    // No leading "." span exists in this case.
    expect(screen.queryByText(".")).toBeNull();
  });

  it("renders a Remove (X) control on the chip so the user can detach the file", async () => {
    const { AttachmentUI } = await import("@/components/assistant-ui/attachment");
    render(<AttachmentUI />);
    expect(screen.getByRole("button", { name: /remove file/i })).toBeInTheDocument();
  });
});

describe("Composer chip — image attachment (NOT a chip — keeps the thumbnail path)", () => {
  beforeEach(() => {
    auiState.source = "composer";
    auiState.type = "image";
    auiState.name = "photo.png";
  });

  it("does NOT render the named chip wrapper for image attachments", async () => {
    const { AttachmentUI } = await import("@/components/assistant-ui/attachment");
    const { container } = render(<AttachmentUI />);
    // The composer chip is identified by title={name} on a wrapping div; image
    // attachments must NOT use this branch — they keep the Avatar thumbnail.
    expect(container.querySelector('[title="photo.png"]')).toBeNull();
  });
});

describe("Thread (non-composer) attachment — no chip", () => {
  beforeEach(() => {
    auiState.source = "thread";
    auiState.type = "document";
    auiState.name = "invoice.pdf";
  });

  it("does NOT render the named chip wrapper on thread attachments (chip is composer-only)", async () => {
    const { AttachmentUI } = await import("@/components/assistant-ui/attachment");
    const { container } = render(<AttachmentUI />);
    // Thread message attachments use the tile path with a hover tooltip — no
    // visible chip with the full filename on the bubble itself.
    expect(container.querySelector('[title="invoice.pdf"]')).toBeNull();
  });
});
