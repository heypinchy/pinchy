import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import { SecretsProvenanceCard } from "@/components/secrets-provenance-card";

function healthResponse(secrets: Record<string, string>) {
  return new Response(JSON.stringify({ status: "ok", secrets }));
}

describe("SecretsProvenanceCard", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows where each secret comes from", async () => {
    fetchSpy.mockResolvedValue(
      healthResponse({
        encryption_key: "file",
        auth_secret: "envvar",
        audit_hmac_secret: "file",
        db_password: "custom",
      })
    );

    render(<SecretsProvenanceCard />);

    await waitFor(() => {
      expect(screen.getByText(/encryption key/i)).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledWith("/api/health");
    expect(screen.getAllByText("Persisted file (Docker volume)").length).toBe(2);
    expect(screen.getByText("Environment variable")).toBeInTheDocument();
    expect(screen.getByText(/auth secret/i)).toBeInTheDocument();
    expect(screen.getByText(/audit signing secret/i)).toBeInTheDocument();
    expect(screen.getByText(/database password/i)).toBeInTheDocument();
    expect(screen.getByText(/custom password/i)).toBeInTheDocument();
  });

  it("flags the default database password", async () => {
    fetchSpy.mockResolvedValue(
      healthResponse({
        encryption_key: "file",
        auth_secret: "unset",
        audit_hmac_secret: "unset",
        db_password: "default",
      })
    );

    render(<SecretsProvenanceCard />);

    await waitFor(() => {
      expect(screen.getByText(/default password/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/DB_PASSWORD/)).toBeInTheDocument();
  });

  it("explains not-yet-created secrets instead of alarming the user", async () => {
    fetchSpy.mockResolvedValue(
      healthResponse({
        encryption_key: "unset",
        auth_secret: "envvar",
        audit_hmac_secret: "unset",
        db_password: "custom",
      })
    );

    render(<SecretsProvenanceCard />);

    await waitFor(() => {
      expect(screen.getAllByText(/generated on first use/i).length).toBe(2);
    });
  });

  it("renders nothing when the health endpoint has no secrets info", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: "ok" })));

    const { container } = render(<SecretsProvenanceCard />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the health fetch fails", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));

    const { container } = render(<SecretsProvenanceCard />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });
});
