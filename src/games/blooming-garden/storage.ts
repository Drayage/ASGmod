import type { Difficulty } from "./ai";
import type { Player } from "./types";

const PREFIX = "abstract-games:blooming-garden";
const SETTINGS_KEY = `${PREFIX}:settings`;
const STATS_KEY = `${PREFIX}:stats`;
const DAILY_KEY = `${PREFIX}:daily`;
const SAVE_VERSION = 1;

export type Mode = "AI" | "LOCAL" | "ONLINE";

export interface Settings {
  version: number;
  /** How the last game was set up, so the mode-select screen offers it again
   * instead of resetting to the defaults on every visit. */
  lastMode: Mode;
  lastDifficulty: Difficulty;
  lastHumanSide: Player;
  lastMapId: string;
  /** Whether the first-visit tutorial has been shown (or skipped). */
  tutorialCompleted: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  version: SAVE_VERSION,
  lastMode: "AI",
  lastDifficulty: "NORMAL",
  lastHumanSide: "A",
  lastMapId: "practice-garden",
  tutorialCompleted: false,
};

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private browsing, quota, etc.) — play on without persistence.
  }
}

export function loadSettings(): Settings {
  const saved = readJson<Settings>(SETTINGS_KEY);
  return saved?.version === SAVE_VERSION ? { ...DEFAULT_SETTINGS, ...saved } : DEFAULT_SETTINGS;
}

export function saveSettings(settings: Settings): void {
  writeJson(SETTINGS_KEY, settings);
}

/**
 * Per-device play record. `wins`/`losses`/`winsByDifficulty` only make sense
 * when there's a single "my side" to score from, so they're left untouched
 * for LOCAL games — two people sharing one device isn't a personal win/loss
 * for either of them. `playsByMap`/`winsByMap` are keyed by map id rather
 * than pre-listing every map, so a stats file from before a map existed (or
 * one that's since been removed) still loads cleanly.
 */
export interface Stats {
  version: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  winsByDifficulty: Record<Difficulty, number>;
  winsByMode: Record<Mode, number>;
  playsByMap: Record<string, number>;
  winsByMap: Record<string, number>;
  /** Consecutive AI/ONLINE wins right now — any loss or draw resets it to 0. */
  currentWinStreak: number;
  /** The longest `currentWinStreak` has ever reached, for achievements. */
  bestWinStreak: number;
}

const DEFAULT_STATS: Stats = {
  version: SAVE_VERSION,
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
};

export function loadStats(): Stats {
  const saved = readJson<Stats>(STATS_KEY);
  // Every branch below must copy the nested Records rather than share
  // DEFAULT_STATS's own — a shallow `{ ...DEFAULT_STATS }` looks like a copy
  // but leaves winsByDifficulty/playsByMap/winsByMap pointing at the same
  // objects, so the first mutation anywhere corrupts the shared default for
  // the rest of the session.
  if (saved?.version !== SAVE_VERSION) {
    return {
      ...DEFAULT_STATS,
      winsByDifficulty: { ...DEFAULT_STATS.winsByDifficulty },
      winsByMode: { ...DEFAULT_STATS.winsByMode },
      playsByMap: {},
      winsByMap: {},
    };
  }
  return {
    ...DEFAULT_STATS,
    ...saved,
    winsByDifficulty: { ...DEFAULT_STATS.winsByDifficulty, ...saved.winsByDifficulty },
    winsByMode: { ...DEFAULT_STATS.winsByMode, ...saved.winsByMode },
    playsByMap: { ...saved.playsByMap },
    winsByMap: { ...saved.winsByMap },
  };
}

export interface MatchOutcome {
  mode: Mode;
  difficulty: Difficulty;
  mapId: string;
  humanSide: Player;
  winner: Player | "DRAW";
}

/** Records one finished game and returns the updated totals. Call exactly
 * once per game, the moment its winner is decided. */
export function recordResult(outcome: MatchOutcome): Stats {
  const stats = loadStats();
  stats.gamesPlayed += 1;
  stats.playsByMap[outcome.mapId] = (stats.playsByMap[outcome.mapId] ?? 0) + 1;

  if (outcome.winner === "DRAW") {
    stats.draws += 1;
    if (outcome.mode !== "LOCAL") stats.currentWinStreak = 0;
  } else if (outcome.mode !== "LOCAL") {
    if (outcome.winner === outcome.humanSide) {
      stats.wins += 1;
      stats.winsByMap[outcome.mapId] = (stats.winsByMap[outcome.mapId] ?? 0) + 1;
      stats.winsByMode[outcome.mode] += 1;
      if (outcome.mode === "AI") stats.winsByDifficulty[outcome.difficulty] += 1;
      stats.currentWinStreak += 1;
      stats.bestWinStreak = Math.max(stats.bestWinStreak, stats.currentWinStreak);
    } else {
      stats.losses += 1;
      stats.currentWinStreak = 0;
    }
  }

  writeJson(STATS_KEY, stats);
  return stats;
}

/** One attempt at a given day's challenge. Replaying the same day overwrites
 * this with the latest attempt rather than only keeping the first — the
 * daily garden is a shared prompt, not a one-shot exam. */
export interface DailyResult {
  mapId: string;
  humanSide: Player;
  winner: Player | "DRAW";
  playedAt: number;
}

function loadDailyResults(): Record<string, DailyResult> {
  return readJson<Record<string, DailyResult>>(DAILY_KEY) ?? {};
}

/** The result recorded for `dateKey` (see `todayKey` in ./daily), or `null`
 * if that day hasn't been played yet. */
export function getDailyResult(dateKey: string): DailyResult | null {
  return loadDailyResults()[dateKey] ?? null;
}

export function recordDailyResult(dateKey: string, result: Omit<DailyResult, "playedAt">): void {
  const all = loadDailyResults();
  all[dateKey] = { ...result, playedAt: Date.now() };
  writeJson(DAILY_KEY, all);
}
