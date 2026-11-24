// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { DiskSpaceBanner } from "@/components/disk-space-banner";
import { jsonResponse } from "@/test-helpers/fetch";
import type { DiskReport } from "@/lib/disk-space";

const LOW: DiskReport = {
  status: "warning",
  volumes: [
    { name: "system", status: "ok", freeGb: 40, totalGb: 80, freePercent: 50 },
    { name: "knowledgeBaseArtifacts", status: "warning", freeGb: 9, totalGb: 38, freePercent: 23 },
  ],
};

describe("DiskSpaceBanner", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    sessionStorage.clear();
  });
  afterEach(() => fetchSpy.mockRestore());

  function health(disk: DiskReport) {
    vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ status: "ok", disk }));
  }

  it("warns an admin with the tightest free space, what grows there, and where to read up", async () => {
    health(LOW);

    render(<DiskSpaceBanner isAdmin />);

    const bar = await screen.findByRole("alert");
    expect(bar).toHaveTextContent("Your server is running low on disk space: 9 GB free.");
    expect(bar).toHaveTextContent(
      "The knowledge-base index, converted documents and Docker images all grow there"
    );
    expect(screen.getByRole("link", { name: /free up space/i })).toHaveAttribute(
      "href",
      "https://docs.heypinchy.com/guides/hardening/#disk-space"
    );
    expect(global.fetch).toHaveBeenCalledWith("/api/health", expect.anything());
  });

  it("shows nothing while there is enough space", async () => {
    health({
      status: "ok",
      volumes: [{ name: "system", status: "ok", freeGb: 90, totalGb: 100, freePercent: 90 }],
    });

    render(<DiskSpaceBanner isAdmin />);

    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows nothing when the disk could not be measured", async () => {
    health({ status: "unknown", volumes: [] });

    render(<DiskSpaceBanner isAdmin />);

    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("never shows or even asks for a member — disk space is an admin's job", () => {
    health(LOW);

    render(<DiskSpaceBanner isAdmin={false} />);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stays visible until dismissed, and stays dismissed for the session", async () => {
    health(LOW);
    const user = userEvent.setup();

    const { unmount } = render(<DiskSpaceBanner isAdmin />);
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    unmount();
    render(<DiskSpaceBanner isAdmin />);
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
