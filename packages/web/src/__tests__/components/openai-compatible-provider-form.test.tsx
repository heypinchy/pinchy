// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  OpenAiCompatibleProviderForm,
  type ProviderListItem,
} from "@/components/openai-compatible-provider-form";
import { jsonResponse } from "@/test-helpers/fetch";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const PROVIDER: ProviderListItem = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme-llm",
  displayName: "Acme LLM",
  baseUrl: "https://acme.example.com/v1",
  models: [],
  keyHint: "7Z8x",
};

const KEY_AGAIN =
  "Enter the API key again when you change the address — the stored key is never sent to a new address.";

describe("OpenAiCompatibleProviderForm — a stored key follows its base URL", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ id: PROVIDER.id }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function renderEdit() {
    render(
      <OpenAiCompatibleProviderForm provider={PROVIDER} onSaved={vi.fn()} onCancel={vi.fn()} />
    );
  }

  function setBaseUrl(value: string) {
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value } });
  }

  it("keeps the 'leave blank' affordance while the base URL is unchanged (trailing slash, letter case)", () => {
    renderEdit();
    setBaseUrl("https://ACME.example.com/v1/");

    expect(screen.getByLabelText("API key")).toHaveAttribute(
      "placeholder",
      "Leave blank to keep current key"
    );
    expect(screen.queryByText(KEY_AGAIN)).not.toBeInTheDocument();
  });

  // Corrected expectation: a path-only change used to keep the stored key. A
  // shared gateway origin routes by path, so the key is bound to the full base
  // URL — the form asks for it again, as the server now demands.
  it("asks for the key again when only the path changes", () => {
    renderEdit();
    setBaseUrl("https://acme.example.com/openai/v1");

    expect(screen.getByLabelText("API key")).toBeRequired();
    expect(screen.getByText(KEY_AGAIN)).toBeInTheDocument();
  });

  it("does not ask for the key over an address that does not parse, and lets the server judge it", async () => {
    renderEdit();
    setBaseUrl("acme.example.com/v1");

    expect(screen.queryByText(KEY_AGAIN)).not.toBeInTheDocument();
    expect(screen.getByLabelText("API key")).not.toBeRequired();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("API key")).not.toHaveAttribute("aria-invalid");
  });

  it("asks for the key again, and does not call the server without it, when the host changes", async () => {
    renderEdit();
    setBaseUrl("https://other.example.net/v1");

    expect(screen.getByLabelText("API key")).not.toHaveAttribute(
      "placeholder",
      "Leave blank to keep current key"
    );
    expect(screen.getByLabelText("API key")).toBeRequired();
    expect(screen.getByText(KEY_AGAIN)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByLabelText("API key")).toHaveAttribute("aria-invalid"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the fresh key along with the new address", async () => {
    renderEdit();
    setBaseUrl("https://other.example.net/v1");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-fresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      id: PROVIDER.id,
      baseUrl: "https://other.example.net/v1",
      apiKey: "sk-fresh",
    });
  });

  it("goes back to 'leave blank' when the address is put back", () => {
    renderEdit();
    setBaseUrl("https://other.example.net/v1");
    setBaseUrl("https://acme.example.com/v1");

    expect(screen.queryByText(KEY_AGAIN)).not.toBeInTheDocument();
    expect(screen.getByLabelText("API key")).not.toBeRequired();
  });

  it("never asks for a key again while adding a new provider", () => {
    render(<OpenAiCompatibleProviderForm provider={null} onSaved={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://other.example.net/v1" },
    });

    expect(screen.queryByText(KEY_AGAIN)).not.toBeInTheDocument();
  });
});
