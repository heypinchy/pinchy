import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import "@testing-library/jest-dom";
import { sendingOpacityClass } from "@/components/assistant-ui/thread";

vi.mock("@assistant-ui/react", () => ({
  MessagePrimitive: {
    Root: ({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) => (
      <div {...props}>{children}</div>
    ),
    Parts: () => null,
    Error: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  },
  useMessage: vi.fn(),
}));

vi.mock("@/components/assistant-ui/attachment", () => ({
  UserMessageAttachments: () => null,
}));

vi.mock("@/components/chat", async () => {
  const React = await import("react");
  return {
    AgentAvatarContext: React.createContext<string | null>(null),
    AgentIdContext: React.createContext<string | null>(null),
  };
});

describe("sendingOpacityClass", () => {
  it("returns 'opacity-60' when status is 'sending'", () => {
    expect(sendingOpacityClass("sending")).toBe("opacity-60");
  });

  it("returns empty string when status is 'sent'", () => {
    expect(sendingOpacityClass("sent")).toBe("");
  });

  it("returns empty string when status is 'failed'", () => {
    expect(sendingOpacityClass("failed")).toBe("");
  });

  it("returns empty string when status is undefined", () => {
    expect(sendingOpacityClass(undefined)).toBe("");
  });
});

describe("UserMessage component", () => {
  it("applies opacity-60 to the content wrapper when status is 'sending'", async () => {
    const { useMessage } = await import("@assistant-ui/react");
    vi.mocked(useMessage).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (selector: (state: any) => unknown) =>
        selector({ metadata: { custom: { status: "sending" } } })
    );

    const { UserMessage } = await import("@/components/assistant-ui/thread");
    const { container } = render(<UserMessage />);

    const wrapper = container.querySelector(".aui-user-message-content-wrapper");
    expect(wrapper).toBeInTheDocument();
    expect(wrapper).toHaveClass("opacity-60");
  });
});
