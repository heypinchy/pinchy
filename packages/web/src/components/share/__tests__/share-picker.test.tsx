import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { SharePicker } from "../share-picker";
import type { Agent } from "@/components/agent-list";

const { readSharedPayload } = vi.hoisted(() => ({
  readSharedPayload: vi.fn(),
}));

vi.mock("@/lib/share-target/share-cache", () => ({
  readSharedPayload,
}));

const push = vi.fn();
const mockSearchParams = { current: new URLSearchParams("share_id=abc") };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => mockSearchParams.current,
}));

const agents: Agent[] = [
  {
    id: "a1",
    name: "Buchhaltung",
    isPersonal: true,
    model: "gpt",
    tagline: null,
    starterPrompts: [],
    avatarSeed: null,
  },
  {
    id: "a2",
    name: "Smithers",
    isPersonal: true,
    model: "gpt",
    tagline: null,
    starterPrompts: [],
    avatarSeed: null,
  },
];

describe("SharePicker", () => {
  beforeEach(() => {
    mockSearchParams.current = new URLSearchParams("share_id=abc");
    readSharedPayload.mockReset();
    push.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists agents and navigates to the chosen agent's chat carrying the share id", async () => {
    readSharedPayload.mockResolvedValue({
      files: [],
      title: "",
      text: "please book this",
      url: "",
    });

    render(<SharePicker agents={agents} />);

    expect(await screen.findByText("Buchhaltung")).toBeInTheDocument();
    expect(screen.getByText("Smithers")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Buchhaltung"));

    expect(push).toHaveBeenCalledWith("/chat/a1?share=abc");
  });

  it("shows an empty state when the share id is unknown", async () => {
    readSharedPayload.mockResolvedValue(null);

    render(<SharePicker agents={agents} />);

    expect(await screen.findByText(/nothing to share/i)).toBeInTheDocument();
  });

  it("shows the shared file's name when a file payload is present", async () => {
    readSharedPayload.mockResolvedValue({
      files: [new File(["x"], "invoice.pdf", { type: "application/pdf" })],
      title: "",
      text: "",
      url: "",
    });

    render(<SharePicker agents={agents} />);

    expect(await screen.findByText("invoice.pdf")).toBeInTheDocument();
  });

  it("shows an image preview element for a shared image", async () => {
    readSharedPayload.mockResolvedValue({
      files: [new File(["x"], "photo.jpg", { type: "image/jpeg" })],
      title: "",
      text: "",
      url: "",
    });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:mock-url") }));

    render(<SharePicker agents={agents} />);

    const img = await screen.findByRole("img", { name: /photo.jpg/i });
    expect(img).toHaveAttribute("src", "blob:mock-url");
  });
});
