import { describe, expect, it } from "vitest";
import { ACHIEVEMENTS, unlockedCount } from "./achievements";
import { maps } from "./maps";
import type { Stats } from "./storage";

function statsWith(overrides: Partial<Stats>): Stats {
  return {
    version: 1,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    winsByDifficulty: { EASY: 0, NORMAL: 0, HARD: 0 },
    winsByMode: { AI: 0, LOCAL: 0, ONLINE: 0 },
    playsByMap: {},
    winsByMap: {},
    currentWinStreak: 0,
    bestWinStreak: 0,
    ...overrides,
  };
}

describe("ACHIEVEMENTS", () => {
  it("has unique ids", () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("unlocks nothing for a fresh, empty stats object", () => {
    const stats = statsWith({});
    expect(unlockedCount(stats)).toBe(0);
  });

  it("unlocks first-win only once a win is recorded", () => {
    const achievement = ACHIEVEMENTS.find((a) => a.id === "first-win")!;
    expect(achievement.isUnlocked(statsWith({ wins: 0 }))).toBe(false);
    expect(achievement.isUnlocked(statsWith({ wins: 1 }))).toBe(true);
  });

  it("requires a win at that specific difficulty, not just any win", () => {
    const beatHard = ACHIEVEMENTS.find((a) => a.id === "beat-hard")!;
    const stats = statsWith({ wins: 3, winsByDifficulty: { EASY: 3, NORMAL: 0, HARD: 0 } });
    expect(beatHard.isUnlocked(stats)).toBe(false);
  });

  it("requires an actual streak of 3, not just 3 total wins", () => {
    const streak = ACHIEVEMENTS.find((a) => a.id === "win-streak-3")!;
    expect(streak.isUnlocked(statsWith({ wins: 5, bestWinStreak: 2 }))).toBe(false);
    expect(streak.isUnlocked(statsWith({ wins: 5, bestWinStreak: 3 }))).toBe(true);
  });

  it("requires every registered map to have been played for all-maps", () => {
    const allMaps = ACHIEVEMENTS.find((a) => a.id === "all-maps")!;
    const partial: Record<string, number> = {};
    for (const map of maps.slice(0, maps.length - 1)) partial[map.id] = 1;
    expect(allMaps.isUnlocked(statsWith({ playsByMap: partial }))).toBe(false);

    const full: Record<string, number> = {};
    for (const map of maps) full[map.id] = 1;
    expect(allMaps.isUnlocked(statsWith({ playsByMap: full }))).toBe(true);
  });

  it("counts unlocked achievements across a mixed stats object", () => {
    const stats = statsWith({
      wins: 5,
      draws: 1,
      winsByDifficulty: { EASY: 1, NORMAL: 0, HARD: 0 },
      bestWinStreak: 1,
    });
    // first-win, beat-easy, five-wins, draw = 4
    expect(unlockedCount(stats)).toBe(4);
  });
});
