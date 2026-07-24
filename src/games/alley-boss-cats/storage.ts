import type { Difficulty } from "./ai";
import type { GameState, Player } from "./types";

const PREFIX = "abstract-games:alley-boss-cats";
const GAME_KEY = `${PREFIX}:current-game`;
const SETTINGS_KEY = `${PREFIX}:settings`;
const STATS_KEY = `${PREFIX}:stats`;
const SAVE_VERSION = 1;

export type Mode = "AI" | "LOCAL";

export interface SavedGame {
  version: number;
  mode: Mode;
  difficulty: Difficulty;
  playerSide: Player;
  state: GameState;
  savedAt: number;
}

export interface Settings {
  version: number;
  soundEnabled: boolean;
  moveConfirmation: boolean;
  showHints: boolean;
  tutorialCompleted: boolean;
}

export interface Stats {
  gamesPlayed: number;
  wins: number;
  losses: number;
  captureWins: number;
  territoryWins: number;
  winsByDifficulty: Record<"EASY" | "NORMAL" | "HARD", number>;
}

const DEFAULT_SETTINGS: Settings = {
  version: SAVE_VERSION,
  soundEnabled: true,
  moveConfirmation: false,
  showHints: false,
  tutorialCompleted: false,
};

const DEFAULT_STATS: Stats = {
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  captureWins: 0,
  territoryWins: 0,
  winsByDifficulty: { EASY: 0, NORMAL: 0, HARD: 0 },
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

export function saveGame(saved: Omit<SavedGame, "version" | "savedAt">): void {
  writeJson(GAME_KEY, { ...saved, version: SAVE_VERSION, savedAt: Date.now() } satisfies SavedGame);
}

export function loadGame(): SavedGame | null {
  const saved = readJson<SavedGame>(GAME_KEY);
  return saved?.version === SAVE_VERSION ? saved : null;
}

export function clearGame(): void {
  try {
    localStorage.removeItem(GAME_KEY);
  } catch {
    // ignore
  }
}

export function loadSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...readJson<Settings>(SETTINGS_KEY) };
}

export function saveSettings(settings: Settings): void {
  writeJson(SETTINGS_KEY, settings);
}

export function loadStats(): Stats {
  return { ...DEFAULT_STATS, ...readJson<Stats>(STATS_KEY) };
}

export function recordResult(outcome: {
  won: boolean;
  reason: "CAPTURE" | "TERRITORY";
  difficulty: Difficulty;
}): Stats {
  const stats = loadStats();
  stats.gamesPlayed += 1;
  if (outcome.won) {
    stats.wins += 1;
    if (outcome.reason === "CAPTURE") stats.captureWins += 1;
    else stats.territoryWins += 1;
    stats.winsByDifficulty[outcome.difficulty] += 1;
  } else {
    stats.losses += 1;
  }
  writeJson(STATS_KEY, stats);
  return stats;
}
