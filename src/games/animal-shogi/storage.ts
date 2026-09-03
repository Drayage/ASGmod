import type { Difficulty } from "./ai";
import type { Player } from "./types";

const PREFIX = "abstract-games:animal-shogi";
const SETTINGS_KEY = `${PREFIX}:settings`;
const SAVE_VERSION = 1;

export type Mode = "AI" | "LOCAL";

export interface Settings {
  version: number;
  /** How the last game was set up, so the mode-select screen offers it
   * again instead of resetting to the defaults on every visit. */
  lastMode: Mode;
  lastDifficulty: Difficulty;
  lastHumanSide: Player;
}

const DEFAULT_SETTINGS: Settings = {
  version: SAVE_VERSION,
  lastMode: "AI",
  lastDifficulty: "NORMAL",
  lastHumanSide: "A",
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
