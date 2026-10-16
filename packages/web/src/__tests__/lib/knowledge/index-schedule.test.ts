import { describe, it, expect } from "vitest";

import {
  DEFAULT_INDEX_SCHEDULE,
  isSlotDue,
  latestPassedSlot,
  localClock,
  nextIndexRun,
  parseIndexSchedule,
  type IndexSchedule,
} from "@/lib/knowledge/index-schedule";

const NIGHTLY: IndexSchedule = { enabled: true, time: "02:00" };

describe("localClock", () => {
  it("reads the wall clock in the org timezone, not the server's", () => {
    // 23:30 UTC on Oct 16 is already 01:30 on Oct 17 in Vienna (CEST, UTC+2).
    const clock = localClock(new Date("2026-10-16T23:30:00Z"), "Europe/Vienna");
    expect(clock).toEqual({ date: "2026-10-17", minutes: 90 });
  });

  // Some runtimes format midnight as hour "24" when asked for a 24-hour clock.
  // Read naively, that is minute 1440 of the PREVIOUS day — a slot that would
  // never be due again, or one due a day early.
  it("reports midnight as minute 0 of the new day", () => {
    const clock = localClock(new Date("2026-10-16T00:00:00Z"), "UTC");
    expect(clock).toEqual({ date: "2026-10-16", minutes: 0 });
  });
});

describe("latestPassedSlot", () => {
  it("is today once the scheduled time has been reached", () => {
    expect(latestPassedSlot({ date: "2026-10-17", minutes: 120 }, NIGHTLY)).toBe("2026-10-17");
  });

  it("is yesterday before the scheduled time", () => {
    expect(latestPassedSlot({ date: "2026-10-17", minutes: 119 }, NIGHTLY)).toBe("2026-10-16");
  });

  it("crosses month and year boundaries", () => {
    expect(latestPassedSlot({ date: "2027-01-01", minutes: 0 }, NIGHTLY)).toBe("2026-12-31");
    expect(latestPassedSlot({ date: "2028-03-01", minutes: 0 }, NIGHTLY)).toBe("2028-02-29");
  });
});

describe("isSlotDue", () => {
  it("is due once the time is reached on a day not yet taken", () => {
    expect(isSlotDue({ date: "2026-10-17", minutes: 125 }, NIGHTLY, "2026-10-16")).toBe(true);
  });

  it("is not due before the time", () => {
    expect(isSlotDue({ date: "2026-10-17", minutes: 60 }, NIGHTLY, "2026-10-16")).toBe(false);
  });

  it("runs a day's slot once, however many ticks follow it", () => {
    expect(isSlotDue({ date: "2026-10-17", minutes: 900 }, NIGHTLY, "2026-10-17")).toBe(false);
  });

  // Pinchy was not running at 02:00. The slot is still the latest one that
  // passed, so it runs when Pinchy comes back — once, not once per missed night.
  it("catches up a missed night when the process comes back", () => {
    expect(isSlotDue({ date: "2026-10-20", minutes: 420 }, NIGHTLY, "2026-10-17")).toBe(true);
  });

  it("is never due while the schedule is off", () => {
    expect(
      isSlotDue({ date: "2026-10-17", minutes: 125 }, { ...NIGHTLY, enabled: false }, "2026-10-16")
    ).toBe(false);
  });

  // Slots are local calendar dates, so the clock changes are non-events rather
  // than arithmetic: there is no instant to convert and get wrong.
  describe("across daylight-saving changes (Europe/Vienna)", () => {
    it("still runs on the spring-forward night, when 02:00 never happens", () => {
      // 2026-03-29: clocks jump from 02:00 straight to 03:00.
      const before = localClock(new Date("2026-03-29T00:59:00Z"), "Europe/Vienna");
      const after = localClock(new Date("2026-03-29T01:00:00Z"), "Europe/Vienna");
      expect(before).toEqual({ date: "2026-03-29", minutes: 119 });
      expect(after).toEqual({ date: "2026-03-29", minutes: 180 });
      expect(isSlotDue(before, NIGHTLY, "2026-03-28")).toBe(false);
      expect(isSlotDue(after, NIGHTLY, "2026-03-28")).toBe(true);
    });

    it("runs once on the fall-back night, when 02:00 happens twice", () => {
      // 2026-10-25: 03:00 CEST becomes 02:00 CET again.
      const first = localClock(new Date("2026-10-25T00:00:00Z"), "Europe/Vienna");
      const second = localClock(new Date("2026-10-25T01:00:00Z"), "Europe/Vienna");
      expect(first).toEqual({ date: "2026-10-25", minutes: 120 });
      expect(second).toEqual({ date: "2026-10-25", minutes: 120 });
      expect(isSlotDue(first, NIGHTLY, "2026-10-24")).toBe(true);
      // The scheduler records the slot when it takes it.
      expect(isSlotDue(second, NIGHTLY, "2026-10-25")).toBe(false);
    });
  });
});

describe("nextIndexRun", () => {
  it("is tonight while today's slot is still ahead", () => {
    expect(nextIndexRun({ date: "2026-10-17", minutes: 60 }, NIGHTLY)).toEqual({
      date: "2026-10-17",
      time: "02:00",
      day: "today",
    });
  });

  it("is tomorrow once today's slot has passed", () => {
    expect(nextIndexRun({ date: "2026-10-17", minutes: 600 }, NIGHTLY)).toEqual({
      date: "2026-10-18",
      time: "02:00",
      day: "tomorrow",
    });
  });

  it("is nothing while the schedule is off", () => {
    expect(nextIndexRun({ date: "2026-10-17", minutes: 60 }, { ...NIGHTLY, enabled: false })).toBe(
      null
    );
  });
});

describe("parseIndexSchedule", () => {
  // On by default: the promise is that new documents become searchable with
  // nobody doing anything, and an opt-in would be one more thing to do.
  it("defaults to on, nightly at 02:00, when nothing has been saved", () => {
    expect(parseIndexSchedule(null)).toEqual({ enabled: true, time: "02:00" });
    expect(DEFAULT_INDEX_SCHEDULE).toEqual({ enabled: true, time: "02:00" });
  });

  it("reads a saved schedule", () => {
    expect(parseIndexSchedule(JSON.stringify({ enabled: false, time: "23:30" }))).toEqual({
      enabled: false,
      time: "23:30",
    });
  });

  // A broken value must not quietly switch the schedule off: that is the one
  // failure nobody would notice until a document goes missing from an answer.
  it("falls back to the default for a value it cannot read", () => {
    expect(parseIndexSchedule("{not json")).toEqual(DEFAULT_INDEX_SCHEDULE);
    expect(parseIndexSchedule(JSON.stringify({ enabled: true, time: "25:00" }))).toEqual(
      DEFAULT_INDEX_SCHEDULE
    );
    expect(parseIndexSchedule(JSON.stringify({ time: "03:00" }))).toEqual(DEFAULT_INDEX_SCHEDULE);
  });
});
