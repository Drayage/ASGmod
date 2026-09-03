import { beforeEach, describe, expect, it } from "vitest";
import { loadStats, recordResult } from "./storage";

/** Minimal localStorage so the storage module can be exercised under node. */
function installStorage(): void {
  const data = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
  Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true });
}

beforeEach(() => {
  installStorage();
});

describe("loadStats", () => {
  it("starts at all zeros with no games played", () => {
    const stats = loadStats();
    expect(stats.gamesPlayed).toBe(0);
    expect(stats.wins).toBe(0);
    expect(stats.playsByMap).toEqual({});
  });
});

describe("recordResult", () => {
  it("counts a win for the human's side in AI mode, attributed to the difficulty", () => {
    recordResult({ mode: "AI", difficulty: "HARD", mapId: "practice-garden", humanSide: "A", winner: "A" });
    const stats = loadStats();
    expect(stats.gamesPlayed).toBe(1);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(0);
    expect(stats.winsByDifficulty.HARD).toBe(1);
    expect(stats.winsByMap["practice-garden"]).toBe(1);
    expect(stats.playsByMap["practice-garden"]).toBe(1);
  });

  it("counts a loss when the AI wins instead of the human", () => {
    recordResult({ mode: "AI", difficulty: "EASY", mapId: "central-pond", humanSide: "A", winner: "B" });
    const stats = loadStats();
    expect(stats.losses).toBe(1);
    expect(stats.wins).toBe(0);
    expect(stats.winsByDifficulty.EASY).toBe(0);
  });

  it("counts a draw regardless of mode", () => {
    recordResult({ mode: "AI", difficulty: "NORMAL", mapId: "practice-garden", humanSide: "A", winner: "DRAW" });
    const stats = loadStats();
    expect(stats.draws).toBe(1);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(0);
  });

  it("tracks plays but never attributes win/loss for LOCAL games", () => {
    recordResult({ mode: "LOCAL", difficulty: "NORMAL", mapId: "four-pots", humanSide: "A", winner: "B" });
    const stats = loadStats();
    expect(stats.gamesPlayed).toBe(1);
    expect(stats.playsByMap["four-pots"]).toBe(1);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(0);
    expect(stats.winsByMap["four-pots"]).toBeUndefined();
  });

  it("counts an ONLINE win but never attributes it to an AI difficulty", () => {
    recordResult({ mode: "ONLINE", difficulty: "NORMAL", mapId: "practice-garden", humanSide: "B", winner: "B" });
    const stats = loadStats();
    expect(stats.wins).toBe(1);
    expect(stats.winsByDifficulty.NORMAL).toBe(0);
  });

  it("accumulates across multiple games", () => {
    recordResult({ mode: "AI", difficulty: "HARD", mapId: "practice-garden", humanSide: "A", winner: "A" });
    recordResult({ mode: "AI", difficulty: "HARD", mapId: "practice-garden", humanSide: "A", winner: "B" });
    recordResult({ mode: "AI", difficulty: "EASY", mapId: "central-pond", humanSide: "A", winner: "A" });

    const stats = loadStats();
    expect(stats.gamesPlayed).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.playsByMap["practice-garden"]).toBe(2);
    expect(stats.playsByMap["central-pond"]).toBe(1);
    expect(stats.winsByDifficulty.HARD).toBe(1);
    expect(stats.winsByDifficulty.EASY).toBe(1);
  });
});
