import { beforeEach, describe, expect, it } from "vitest";
import { exportRecords, importRecords, loadRecords, loadSettings, saveRecord, saveSettings } from "./storage";
import type { Move } from "./types";

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

const MOVES: Move[] = [
  { turn: 1, player: "A", type: "PLACE", row: 4, col: 2 },
  { turn: 2, player: "B", type: "PLACE", row: 2, col: 4 },
  { turn: 3, player: "A", type: "PASS" },
];

function sampleRecord(overrides: Partial<Parameters<typeof saveRecord>[0]> = {}) {
  return saveRecord({
    mode: "AI",
    difficulty: "VERY_HARD",
    playerSide: "A",
    winner: "A",
    winReason: "CAPTURE",
    territoryA: 12,
    territoryB: 7,
    moveHistory: MOVES,
    ...overrides,
  });
}

beforeEach(() => {
  installStorage();
});

describe("match records", () => {
  it("stores a finished game and reads it back whole", () => {
    const saved = sampleRecord();
    const [loaded] = loadRecords();

    expect(loaded.id).toBe(saved.id);
    expect(loaded.moveHistory).toEqual(MOVES);
    expect(loaded.territoryA).toBe(12);
  });

  it("lists the most recent game first", () => {
    const older = sampleRecord();
    const newer = sampleRecord({ winner: "B" });
    const ids = loadRecords().map((r) => r.id);

    // Both were saved in the same millisecond, so ordering has to survive that.
    expect(ids).toHaveLength(2);
    expect(ids).toContain(older.id);
    expect(ids[0]).toBe(newer.id);
  });
});

describe("export / import", () => {
  it("round-trips through an exported file", () => {
    const saved = sampleRecord();
    const file = exportRecords();

    localStorage.clear();
    expect(loadRecords()).toHaveLength(0);

    expect(importRecords(file)).toEqual({ added: 1, duplicates: 0, rejected: 0 });
    expect(loadRecords()[0].id).toBe(saved.id);
    expect(loadRecords()[0].moveHistory).toEqual(MOVES);
  });

  it("importing the same file twice adds nothing the second time", () => {
    sampleRecord();
    const file = exportRecords();

    expect(importRecords(file).duplicates).toBe(1);
    expect(loadRecords()).toHaveLength(1);
  });

  it("merges a file from another device without dropping local games", () => {
    sampleRecord();
    const foreign = JSON.stringify({
      format: "alley-boss-cats-records",
      version: 1,
      exportedAt: Date.now(),
      records: [
        {
          id: "from-another-device",
          finishedAt: Date.now() - 60_000,
          mode: "AI",
          difficulty: "HARD",
          playerSide: "B",
          winner: "B",
          winReason: "TERRITORY",
          territoryA: 4,
          territoryB: 9,
          moveHistory: MOVES,
        },
      ],
    });

    expect(importRecords(foreign).added).toBe(1);
    expect(loadRecords()).toHaveLength(2);
  });

  it("skips unusable entries instead of failing the whole import", () => {
    const file = JSON.stringify({
      format: "alley-boss-cats-records",
      version: 1,
      records: [
        { id: "junk" },
        { id: "half", finishedAt: 1, winner: "C", winReason: "CAPTURE", moveHistory: [] },
        {
          id: "good",
          finishedAt: 2,
          mode: "AI",
          difficulty: "EASY",
          playerSide: "A",
          winner: "A",
          winReason: "CAPTURE",
          territoryA: 1,
          territoryB: 0,
          moveHistory: MOVES,
        },
      ],
    });

    expect(importRecords(file)).toEqual({ added: 1, duplicates: 0, rejected: 2 });
    expect(loadRecords().map((r) => r.id)).toEqual(["good"]);
  });

  it("rejects a file that is not a records export", () => {
    expect(() => importRecords("not json at all")).toThrow();
    expect(() => importRecords(JSON.stringify({ hello: "world" }))).toThrow();
  });
});

describe("remembered game setup", () => {
  it("defaults before anything has been played, then keeps the last choice", () => {
    expect(loadSettings().lastDifficulty).toBe("NORMAL");
    expect(loadSettings().lastHumanSide).toBe("A");

    saveSettings({ ...loadSettings(), lastDifficulty: "VERY_HARD", lastHumanSide: "B", lastMode: "LOCAL" });

    const reloaded = loadSettings();
    expect(reloaded.lastDifficulty).toBe("VERY_HARD");
    expect(reloaded.lastHumanSide).toBe("B");
    expect(reloaded.lastMode).toBe("LOCAL");
    // Unrelated settings must survive being written alongside them.
    expect(reloaded.soundEnabled).toBe(true);
  });
});
