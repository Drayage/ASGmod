/**
 * How much of an early position's final margin is decided by the position, and
 * how much by whatever happens next?
 *
 * The scaling curve says the opening is not data-limited: training on 20, 40,
 * 80 and 160 games moves the opening correlation not at all (0.135, 0.231,
 * 0.185, 0.180) while the endgame climbs steadily. Eight times the data buys
 * nothing early, so the ceiling is not sample count.
 *
 * The suspicion is the label. Every position in a game is tagged with that
 * game's single final margin, and from an early position that margin is mostly
 * a record of what the engine went on to do — not what the position was worth.
 * If so, no model can predict it, because there is nothing there to predict.
 *
 * This measures it directly. Replay one position to a count many times, letting
 * play vary, and look at the spread of the results. That spread is the part of
 * the label no model can ever explain, and it caps correlation at
 *
 *     r_max = sqrt(1 - noiseVar / totalVar)
 *
 * A large spread early would mean the labels have to change — averaging several
 * playouts instead of taking one — rather than the dataset having to grow.
 *
 *   npx vite-node label-noise.mts -- --input positions.jsonl --playouts 12
 */
import { readFileSync } from "node:fs";
import { applyAction, evaluateState, getSafeActions } from "./src/games/alley-boss-cats/ai";
import type { AIAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { BOARD_SIZE } from "./src/games/alley-boss-cats/types";
import type { Board, Cell, GameState } from "./src/games/alley-boss-cats/types";

function arg(name: string, fallback: string | null = null): string | null {
  const flag = process.argv.indexOf(`--${name}`);
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

function decodeBoard(encoded: string): Board {
  const board: Board = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const line: Cell[] = [];
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const character = encoded[row * BOARD_SIZE + col];
      line.push(
        character === "A"
          ? "PLAYER_A"
          : character === "B"
            ? "PLAYER_B"
            : character === "N"
              ? "NEUTRAL"
              : "EMPTY",
      );
    }
    board.push(line);
  }
  return board;
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Play to a count, choosing among the best few moves rather than always the
 * single best.
 *
 * The variation is the point: the engine is close to deterministic, and a
 * deterministic playout would report a spread of zero and prove nothing about
 * how settled the position is. Sampling the top few is the cheapest stand-in
 * for "reasonable play could go several ways from here".
 */
function playoutToCount(start: GameState, random: () => number, topK: number): number {
  let state = start;
  let plies = 0;
  while (!state.winner && plies < 220) {
    const player = state.currentPlayer;
    const { pool } = getSafeActions(state, player);
    const scored = pool
      .map((action: AIAction) => {
        const next = applyAction(state, action);
        const endsGame = next.winner !== null && next.winReason === "CAPTURE";
        return { action, next, endsGame, score: evaluateState(next, player) };
      })
      // A capture wins outright and would stop the game before it can be
      // counted, which is the whole thing the label needs to avoid.
      .filter((entry) => !entry.endsGame)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) break;
    const pick = scored[Math.floor(random() * Math.min(topK, scored.length))];
    state = pick.next;
    plies += 1;
  }
  const territories = calculateTerritories(state.board);
  return territories.A.length - territories.B.length;
}

const inputPath = arg("input");
if (!inputPath) throw new Error("usage: label-noise.mts -- --input <positions.jsonl>");
const playouts = Number(arg("playouts", "12"));
const topK = Number(arg("top-k", "3"));
const perPhase = Number(arg("per-phase", "12"));

interface Sample {
  board: string;
  ply: number;
  label: number;
}

const rows: Sample[] = [];
for (const line of readFileSync(inputPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const parsed = JSON.parse(line);
  if ((parsed.symmetry ?? parsed.sym ?? 0) !== 0) continue;
  rows.push({
    board: parsed.board,
    ply: parsed.ply ?? 0,
    label: parsed.margin ?? parsed.finalMargin,
  });
}

const PHASES: Array<[string, number, number]> = [
  ["opening   ply < 20", 0, 20],
  ["middle 20 <= ply < 40", 20, 40],
  ["endgame   ply >= 40", 40, 10_000],
];

console.log(
  `${rows.length} positions; ${perPhase} per phase x ${playouts} playouts, top-${topK} sampling\n`,
);
console.log(
  `${"phase".padEnd(24)}${"labelSD".padStart(9)}${"noiseSD".padStart(9)}` +
    `${"explainable".padStart(13)}${"r_max".padStart(8)}`,
);

for (const [label, lo, hi] of PHASES) {
  const inPhase = rows.filter((row) => row.ply >= lo && row.ply < hi);
  if (inPhase.length === 0) continue;

  // Spread of the labels themselves across positions — the total a model could
  // in principle account for.
  const labels = inPhase.map((row) => row.label);
  const labelMean = labels.reduce((a, b) => a + b, 0) / labels.length;
  const labelVar =
    labels.reduce((sum, value) => sum + (value - labelMean) ** 2, 0) / (labels.length - 1);

  // Spread within one position, replayed. This part is not a property of the
  // position at all, so no model can reach it.
  const step = Math.max(1, Math.floor(inPhase.length / perPhase));
  const withinVars: number[] = [];
  for (let index = 0; index < inPhase.length && withinVars.length < perPhase; index += step) {
    const sample = inPhase[index];
    const base = createInitialState();
    const state: GameState = {
      ...base,
      board: decodeBoard(sample.board),
      territories: calculateTerritories(decodeBoard(sample.board)),
      currentPlayer: sample.ply % 2 === 0 ? "A" : "B",
    };
    const results: number[] = [];
    for (let run = 0; run < playouts; run += 1) {
      results.push(playoutToCount(state, seededRandom(1000 + index * 97 + run * 7919), topK));
    }
    const mean = results.reduce((a, b) => a + b, 0) / results.length;
    withinVars.push(
      results.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (results.length - 1),
    );
  }

  const noiseVar = withinVars.reduce((a, b) => a + b, 0) / withinVars.length;
  const explainable = Math.max(0, 1 - noiseVar / labelVar);
  console.log(
    `${label.padEnd(24)}${Math.sqrt(labelVar).toFixed(3).padStart(9)}` +
      `${Math.sqrt(noiseVar).toFixed(3).padStart(9)}` +
      `${(explainable * 100).toFixed(1).padStart(12)}%` +
      `${Math.sqrt(explainable).toFixed(3).padStart(8)}`,
  );
}
