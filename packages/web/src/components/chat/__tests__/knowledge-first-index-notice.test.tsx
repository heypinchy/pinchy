// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

import { jsonResponse } from "@/test-helpers/fetch";
import { KnowledgeFirstIndexNotice, FIRST_INDEX_POLL_MS } from "../knowledge-first-index-notice";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("KnowledgeFirstIndexNotice", () => {
  it("shows nothing, and stops asking, once the agent's documents are indexed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: "none" }));

    const { container } = render(<KnowledgeFirstIndexNotice agentId="agent-1" />);
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_INDEX_POLL_MS * 3);
    });

    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/agents/agent-1/knowledge/first-index");
  });

  it("shows how far the first index has got", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: "indexing", processed: 120, total: 505 }));

    render(<KnowledgeFirstIndexNotice agentId="agent-1" />);
    await settle();

    expect(screen.getByRole("status")).toHaveTextContent("120 of 505");
  });

  it("says the documents are still being found before the count is known", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: "indexing", processed: 0, total: null }));

    render(<KnowledgeFirstIndexNotice agentId="agent-1" />);
    await settle();

    expect(screen.getByRole("status")).toHaveTextContent(/finding/i);
  });

  it("says the first index is waiting its turn", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: "queued" }));

    render(<KnowledgeFirstIndexNotice agentId="agent-1" />);
    await settle();

    expect(screen.getByRole("status")).toHaveTextContent(/hasn.t started yet/i);
  });

  it("keeps the count current and goes away when the run is done", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ state: "indexing", processed: 120, total: 505 }))
      .mockResolvedValueOnce(jsonResponse({ state: "indexing", processed: 300, total: 505 }))
      .mockResolvedValue(jsonResponse({ state: "none" }));

    render(<KnowledgeFirstIndexNotice agentId="agent-1" />);
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("120 of 505");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_INDEX_POLL_MS);
    });
    expect(screen.getByRole("status")).toHaveTextContent("300 of 505");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_INDEX_POLL_MS);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows nothing for an answer it does not recognise", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: "reticulating" }));

    const { container } = render(<KnowledgeFirstIndexNotice agentId="agent-1" />);
    await settle();

    expect(container).toBeEmptyDOMElement();
  });

  it("keeps asking through a failed request rather than giving up silently", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ state: "queued" }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(jsonResponse({ state: "indexing", processed: 1, total: 2 }));

    render(<KnowledgeFirstIndexNotice agentId="agent-1" />);
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_INDEX_POLL_MS * 2);
    });

    expect(screen.getByRole("status")).toHaveTextContent("1 of 2");
  });
});
