// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DevToolbar } from "@/components/dev-toolbar";
import { jsonResponse } from "@/test-helpers/fetch";

describe("DevToolbar", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows Enterprise when the server says so", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ enterprise: true }));
    render(<DevToolbar />);
    expect(await screen.findByText("Enterprise")).toBeInTheDocument();
  });

  it("shows Community for a real enterprise: false", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ enterprise: false }));
    render(<DevToolbar />);
    expect(await screen.findByText("Community")).toBeInTheDocument();
  });

  // During a tsx-watch restart the status fetch is refused or dropped, and a
  // 401 body carries no `enterprise` at all. None of those is a verdict.
  it.each([
    ["rejects", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["answers 500", async () => jsonResponse({ error: "Internal Server Error" }, { status: 500 })],
    ["answers 401", async () => jsonResponse({ error: "Unauthorized" }, { status: 401 })],
  ])("renders no badge while the status fetch %s", async (_label, statusResponse) => {
    fetchSpy.mockImplementation(statusResponse);
    render(<DevToolbar />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // Let the failed response settle before asserting it rendered nothing.
    await act(async () => {});
    await act(async () => {});

    expect(screen.queryByText("Community")).not.toBeInTheDocument();
    expect(screen.queryByText("Enterprise")).not.toBeInTheDocument();
  });
});
