import { describe, expect, it } from "vitest";
import { dailyMapId, todayKey } from "./daily";
import { findMap } from "./maps";

describe("todayKey", () => {
  it("formats as YYYY-MM-DD from local date fields", () => {
    const date = new Date(2026, 8, 3); // September 3, 2026 (JS months are 0-indexed)
    expect(todayKey(date)).toBe("2026-09-03");
  });

  it("zero-pads single-digit months and days", () => {
    const date = new Date(2026, 0, 5); // January 5, 2026
    expect(todayKey(date)).toBe("2026-01-05");
  });
});

describe("dailyMapId", () => {
  it("always resolves to a real, existing map", () => {
    for (const key of ["2026-09-03", "2026-01-01", "2027-12-31", "2000-06-15"]) {
      expect(findMap(dailyMapId(key))).toBeDefined();
    }
  });

  it("is deterministic for the same date key", () => {
    expect(dailyMapId("2026-09-03")).toBe(dailyMapId("2026-09-03"));
  });

  it("varies across different dates (not the same map every day)", () => {
    const ids = new Set(
      Array.from({ length: 30 }, (_, i) => dailyMapId(todayKey(new Date(2026, 0, i + 1)))),
    );
    expect(ids.size).toBeGreaterThan(1);
  });
});
