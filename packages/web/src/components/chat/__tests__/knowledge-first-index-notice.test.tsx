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

  it("says the first index is about to start, without inventing a run ahead of it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: "queued" }));

    render(<KnowledgeFirstIndexNotice agentId="agent-1" />);
    await settle();

    expect(screen.getByRole("status")).toHaveTextContent(/starts in a moment/i);
    expect(screen.getByRole("status")).not.toHaveTextContent(/run that.s going/i);
  });

  it("says the first index waits for the run that is going now", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: "waiting" }));

    render(<KnowledgeFirstIndexNotice agentId="agent-1" />);
    await settle();

    expect(screen.getByRole("status")).toHaveTextContent(/right after the run that.s going now/i);
  });

  it("says only the new folders are missing when the agent answers from others meanwhile", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ state: "indexing", processed: 2, total: 9, partial: true })
    );

    render(<KnowledgeFirstIndexNotice agentId="agent-1" />);
    await settle();

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/newly added folders/i);
    expect(status).toHaveTextContent("2 of 9");
    expect(status).not.toHaveTextContent(/can.t find anything/i);
  });

  it("stops asking once the route refuses", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Agent not found" }, { status: 404 }));

    render(<KnowledgeFirstIndexNotice agentId="agent-1" />);
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_INDEX_POLL_MS * 3);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks again when the very first request fails", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(jsonResponse({ state: "queued" }));

    render(<KnowledgeFirstIndexNotice agentId="agent-1" />);
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_INDEX_POLL_MS);
    });

    expect(screen.getByRole("status")).toHaveTextContent(/starts in a moment/i);
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
