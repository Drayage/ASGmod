import type { Difficulty } from "./ai";
import type { AIVariant } from "./aiVariant";
import type { GameState, Move, Player, WinReason } from "./types";
import { APP_VERSION, BUILD_TIME } from "./version";

const PREFIX = "abstract-games:alley-boss-cats";
const GAME_KEY = `${PREFIX}:current-game`;
const SETTINGS_KEY = `${PREFIX}:settings`;
const STATS_KEY = `${PREFIX}:stats`;
const RECORDS_KEY = `${PREFIX}:records`;
const SAVE_VERSION = 1;

/** Finished games kept on the device. Old ones fall off the end rather than
 * growing until localStorage refuses to write. */
const MAX_RECORDS = 50;

export type Mode = "AI" | "LOCAL";

export interface SavedGame {
  version: number;
  mode: Mode;
  difficulty: Difficulty;
  /** Kept so resuming carries on with the same engine it started with. */
  aiVariant?: AIVariant;
  playerSide: Player;
  state: GameState;
  savedAt: number;
}

/**
 * How much of the danger on the board to draw.
 *
 * 0 marks nothing, for players who would rather read it themselves.
 * 1 rings cats already one move from being taken — what the game has always
 *   shown.
 * 2 also dots every empty point where placing a cat would hand the opponent a
 *   capture on their next move. That is the same fact one move earlier, and it
 *   is the one a player cannot see by looking at what is on the board.
 */
export type DangerLevel = 0 | 1 | 2;

export interface Settings {
  version: number;
  soundEnabled: boolean;
  musicEnabled: boolean;
  moveConfirmation: boolean;
  showHints: boolean;
  dangerLevel: DangerLevel;
  tutorialCompleted: boolean;
  /** How the last game was set up, so the title screen can offer it again
   * instead of resetting to the defaults on every visit. */
  lastMode: Mode;
  lastDifficulty: Difficulty;
  /** Which named engine settings the last game used. */
  lastAIVariant: AIVariant;
  lastHumanSide: Player;
}

/**
 * A finished game, kept so it can be replayed, studied, and carried between
 * devices. The move list is the whole game — every position is derived by
 * replaying it — so this stays small enough to store dozens of.
 */
/** What one AI decision cost, against what it was allowed. */
export interface AITiming {
  turn: number;
  /** Wall-clock time the engine actually took to answer. */
  elapsedMs: number;
  /** Budget it was given. A phone that never gets near this is being starved,
   * which looks exactly like a bad move unless the record says otherwise. */
  budgetMs: number;
  /** Deepest ply the search finished. Together with the elapsed time this is
   * what separates "thought hard and chose this" from "never got going". */
  depth?: number;
  /** True when the search failed or timed out and a weaker fallback played. */
  fallback?: boolean;
}

export interface MatchRecord {
  id: string;
  finishedAt: number;
  /** Build that played the game — a commit, or "dev" outside a real build. */
  appVersion: string;
  buildTime: string;
  mode: Mode;
  difficulty: Difficulty;
  /** Which named engine settings played this game, so records can be
   * grouped by it later. Absent on games recorded before variants existed. */
  aiVariant?: AIVariant;
  playerSide: Player;
  winner: Player;
  winReason: Exclude<WinReason, null>;
  territoryA: number;
  territoryB: number;
  moveHistory: Move[];
  /** One entry per AI decision. Empty for local two-player games. */
  aiTimings: AITiming[];
}

/** Shape of an exported file. Versioned so a future format can be recognised
 * rather than silently misread. */
export interface RecordsExport {
  format: "alley-boss-cats-records";
  version: number;
  exportedAt: number;
  records: MatchRecord[];
}

export interface Stats {
  gamesPlayed: number;
  wins: number;
  losses: number;
  captureWins: number;
  territoryWins: number;
  winsByDifficulty: Record<Difficulty, number>;
}

const DEFAULT_SETTINGS: Settings = {
  version: SAVE_VERSION,
  soundEnabled: true,
  musicEnabled: false,
  moveConfirmation: false,
  showHints: false,
  // 1 is what every existing save was playing with before this setting existed,
  // and loadSettings merges over the defaults, so they keep it.
  dangerLevel: 1,
  tutorialCompleted: false,
  lastMode: "AI",
  lastDifficulty: "NORMAL",
  // The diagonal bonus is the one change in this branch that cleared the bar it
  // was given beforehand: 60.8% of 186 arena games, +0.95 cells of territory
  // margin, and fewer groups lost, not more. The variant list stays as it is
  // rather than folding it in everywhere — it is the instrument, and past
  // records split by `aiVariant`, so changing what a name means would make them
  // incomparable.
  lastAIVariant: "EYE_CORNER_DIAG",
  lastHumanSide: "A",
};

const DEFAULT_STATS: Stats = {
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  captureWins: 0,
  territoryWins: 0,
  winsByDifficulty: { EASY: 0, NORMAL: 0, HARD: 0, VERY_HARD: 0 },
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

export function loadRecords(): MatchRecord[] {
  const records = readJson<MatchRecord[]>(RECORDS_KEY);
  if (!Array.isArray(records)) return [];
  return records.filter(isRecord).map(normalise).sort((a, b) => b.finishedAt - a.finishedAt);
}

/** Rejects anything that would break the replay screen — an imported file is
 * arbitrary user input, and a bad entry must not take the list down with it. */
function isRecord(value: unknown): value is MatchRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<MatchRecord>;
  return (
    typeof r.id === "string" &&
    typeof r.finishedAt === "number" &&
    (r.winner === "A" || r.winner === "B") &&
    (r.winReason === "CAPTURE" || r.winReason === "TERRITORY") &&
    Array.isArray(r.moveHistory) &&
    r.moveHistory.every(
      (m) =>
        m &&
        typeof m === "object" &&
        (m.type === "PASS" ||
          (m.type === "PLACE" && Number.isInteger(m.row) && Number.isInteger(m.col))),
    )
  );
}

/** Fills in fields added after a record was written. Files exported before the
 * build stamp existed are still worth keeping — they just cannot say which
 * build played them, which is exactly what "알 수 없음" records. */
function normalise(record: MatchRecord): MatchRecord {
  return {
    ...record,
    appVersion: record.appVersion ?? "알 수 없음",
    buildTime: record.buildTime ?? "",
    aiTimings: Array.isArray(record.aiTimings) ? record.aiTimings : [],
  };
}

export function saveRecord(
  record: Omit<MatchRecord, "id" | "finishedAt" | "appVersion" | "buildTime">,
): MatchRecord {
  const finishedAt = Date.now();
  const full: MatchRecord = {
    ...record,
    id: `${finishedAt}-${Math.random().toString(36).slice(2, 8)}`,
    finishedAt,
    appVersion: APP_VERSION,
    buildTime: BUILD_TIME,
  };
  writeJson(RECORDS_KEY, [full, ...loadRecords()].slice(0, MAX_RECORDS));
  return full;
}

export function deleteRecord(id: string): void {
  writeJson(RECORDS_KEY, loadRecords().filter((r) => r.id !== id));
}

export function clearRecords(): void {
  writeJson(RECORDS_KEY, []);
}

export function exportRecords(records: MatchRecord[] = loadRecords()): string {
  return JSON.stringify(
    { format: "alley-boss-cats-records", version: SAVE_VERSION, exportedAt: Date.now(), records } satisfies RecordsExport,
    null,
    2,
  );
}

export interface ImportOutcome {
  added: number;
  /** Already present, matched by id — importing the same file twice is a no-op. */
  duplicates: number;
  /** Present in the file but not a usable game record. */
  rejected: number;
}

/** Merges a previously exported file into the stored list. Throws only when the
 * file is not a records export at all; individual bad entries are counted and
 * skipped so one corrupt game cannot block the rest. */
export function importRecords(json: string): ImportOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("파일을 읽을 수 없습니다. 내보내기로 만든 파일이 맞는지 확인해 주세요.");
  }

  const incoming = Array.isArray(parsed)
    ? parsed
    : (parsed as Partial<RecordsExport> | null)?.records;
  if (!Array.isArray(incoming)) {
    throw new Error("기보 파일 형식이 아닙니다.");
  }

  const existing = loadRecords();
  const seen = new Set(existing.map((r) => r.id));
  const outcome: ImportOutcome = { added: 0, duplicates: 0, rejected: 0 };
  const merged = [...existing];

  for (const entry of incoming) {
    if (!isRecord(entry)) {
      outcome.rejected += 1;
      continue;
    }
    if (seen.has(entry.id)) {
      outcome.duplicates += 1;
      continue;
    }
    seen.add(entry.id);
    merged.push(entry);
    outcome.added += 1;
  }

  merged.sort((a, b) => b.finishedAt - a.finishedAt);
  writeJson(RECORDS_KEY, merged.slice(0, MAX_RECORDS));
  return outcome;
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
