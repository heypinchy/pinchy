// The settings server page hands the License tab the shared agents that are
// Restricted with no group (#1278). Read only where the card shows them.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock("@/lib/auth", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/enterprise", () => ({
  getLicenseStatus: vi.fn(),
  isKeyFromEnv: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/seat-usage", () => ({ getSeatUsage: vi.fn().mockResolvedValue({ used: 1 }) }));
vi.mock("@/lib/gated-config", () => ({ hasGatedConfig: vi.fn().mockResolvedValue(false) }));
vi.mock("@/lib/admin-only-agents", () => ({ listAdminOnlyAgents: vi.fn() }));
vi.mock("@/components/settings-page-content", () => ({ SettingsPageContent: () => null }));

import { getSession } from "@/lib/auth";
import { getLicenseStatus } from "@/lib/enterprise";
import { listAdminOnlyAgents } from "@/lib/admin-only-agents";
import { mockSession } from "@/test-helpers/auth";
import SettingsPage from "@/app/(app)/settings/page";

const stranded = [{ id: "a1", name: "Sales Bot" }];

async function renderProps() {
  const el = (await SettingsPage({ searchParams: Promise.resolve({}) })) as ReactElement<{
    initialAdminOnlyAgents: unknown;
  }>;
  return el.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(mockSession());
  vi.mocked(listAdminOnlyAgents).mockResolvedValue(stranded);
});

describe("Settings server page — admin-only agents", () => {
  it("passes them under an active license", async () => {
    vi.mocked(getLicenseStatus).mockResolvedValue({
      active: true,
      expired: false,
      type: "paid",
      features: [],
      ver: 1,
      maxUsers: 0,
    });
    expect((await renderProps()).initialAdminOnlyAgents).toEqual(stranded);
  });

  it("passes them on a community instance, ahead of activation", async () => {
    vi.mocked(getLicenseStatus).mockResolvedValue({
      active: false,
      expired: false,
      features: [],
      ver: 1,
      maxUsers: 0,
    });
    expect((await renderProps()).initialAdminOnlyAgents).toEqual(stranded);
  });

  it("does not read them for a member", async () => {
    vi.mocked(getSession).mockResolvedValue(mockSession({ user: { role: "member" } }));
    vi.mocked(getLicenseStatus).mockResolvedValue({
      active: true,
      expired: false,
      type: "paid",
      features: [],
      ver: 1,
      maxUsers: 0,
    });
    expect((await renderProps()).initialAdminOnlyAgents).toEqual([]);
    expect(listAdminOnlyAgents).not.toHaveBeenCalled();
  });
});
