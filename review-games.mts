/**
 * Replay a recorded games export and say what happened in it.
 *
 * Reads the app's own export format, so anything played in the app can be put
 * through the same measurements the recorded human and pro games go through.
 *
 *   npx vite-node review-games.mts <path-to-export.json>
 */
import { readFileSync } from "node:fs";
import { applyAction, projectedMargin } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { influenceOwnerMap, influenceCountFromMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { FIRST_PLAYER_MARGIN, opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

interface Move {
  turn: number;
  player: Player;
  type: string;
  row?: number;
  col?: number;
}
interface Timing {
  turn: number;
  elapsedMs: number;
  budgetMs: number;
  depth: number;
}
interface Record_ {
  difficulty?: string;
  playerSide: Player;
  winner: Player | null;
  winReason?: string;
  territoryA?: number;
  territoryB?: number;
  moveHistory: Move[];
  aiTimings?: Timing[];
  appVersion?: string;
}

const path = process.argv[2];
if (!path) throw new Error("usage: npx vite-node review-games.mts <export.json>");
const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };

const COLUMNS = "ABCDEFGHI";
const name = (row: number, col: number) => `${COLUMNS[col]}${row + 1}`;

/** Turn-by-turn: seals on offer, seals taken, and the engine's own read. */
interface Side {
  turns: number;
  sealAvailable: number;
  sealTaken: number;
  cellsOffered: number;
  cellsTaken: number;
}
const blank = (): Side => ({
  turns: 0,
  sealAvailable: 0,
  sealTaken: 0,
  cellsOffered: 0,
  cellsTaken: 0,
});

for (const [index, record] of parsed.records.entries()) {
  const human = record.playerSide;
  const ai = opponent(human);
  const stats: Record<string, Side> = { human: blank(), ai: blank() };

  let state: GameState = createInitialState();
  /** The engine's own margin estimate, from the AI's side, over the game. */
  const readout: Array<{ turn: number; margin: number }> = [];
  let captureTurn: number | null = null;
  /** Every AI turn where a 2+ seal was there and it played something else. */
  const declined: Array<{ turn: number; best: string; cells: number; played: string }> = [];

  for (const move of record.moveHistory) {
    if (state.winner) break;
    const mover = state.currentPlayer;
    const who = mover === human ? "human" : "ai";
    const side = stats[who];
    side.turns += 1;

    const seals = findSealingMoves(state, mover).filter((s) => s.gained.length >= 2);
    if (seals.length > 0) {
      side.sealAvailable += 1;
      side.cellsOffered += Math.max(...seals.map((s) => s.gained.length));
      const took = seals.find(
        (s) => move.type === "PLACE" && s.move.row === move.row && s.move.col === move.col,
      );
      if (took) {
        side.sealTaken += 1;
        side.cellsTaken += took.gained.length;
      } else if (mover === ai) {
        const best = seals.reduce((a, b) => (b.gained.length > a.gained.length ? b : a));
        declined.push({
          turn: move.turn,
          best: name(best.move.row, best.move.col),
          cells: best.gained.length,
          played: move.type === "PLACE" ? name(move.row!, move.col!) : "PASS",
        });
      }
    }

    if (mover === ai) readout.push({ turn: move.turn, margin: projectedMargin(state, ai) });

    const before = state;
    state =
      move.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
    if (!before.winner && state.winner && state.winReason === "CAPTURE") captureTurn = move.turn;
  }

  const owners = influenceOwnerMap(state.board);
  const influence = influenceCountFromMap(owners);

  console.log(`\n${"=".repeat(64)}`);
  console.log(
    `game ${index + 1}  (${record.difficulty ?? "?"})  human plays ${human}, AI plays ${ai}`,
  );
  const won = record.winner === human ? "human wins" : "AI wins";
  console.log(
    `  result: ${won} by ${record.winReason}` +
      `   territory A ${record.territoryA} : B ${record.territoryB}` +
      `   (${record.moveHistory.length} moves)`,
  );
  if (captureTurn !== null) console.log(`  capture landed on turn ${captureTurn}`);

  console.log(`\n  2+ cell seals:`);
  console.log(
    `${"".padEnd(10)}${"turns".padStart(7)}${"offered".padStart(10)}${"taken".padStart(8)}` +
      `${"take rate".padStart(11)}${"cells won".padStart(11)}`,
  );
  for (const label of ["human", "ai"]) {
    const s = stats[label];
    console.log(
      `  ${label.padEnd(8)}${String(s.turns).padStart(7)}${String(s.sealAvailable).padStart(10)}` +
        `${String(s.sealTaken).padStart(8)}` +
        `${(s.sealAvailable === 0 ? "—" : `${((s.sealTaken / s.sealAvailable) * 100).toFixed(0)}%`).padStart(11)}` +
        `${String(s.cellsTaken).padStart(11)}`,
    );
  }

  // What the AI believed, against what was true. Sampled so it reads as a line
  // rather than a wall.
  const truth =
    record.territoryA !== undefined && record.territoryB !== undefined
      ? (ai === "A" ? 1 : -1) * (record.territoryA - record.territoryB) -
        (ai === "A" ? FIRST_PLAYER_MARGIN : -FIRST_PLAYER_MARGIN)
      : null;
  console.log(`\n  what the AI thought its margin was (its own projectedMargin):`);
  const step = Math.max(1, Math.floor(readout.length / 8));
  const line = readout
    .filter((_, i) => i % step === 0)
    .map((r) => `t${r.turn}:${r.margin.toFixed(1)}`)
    .join("  ");
  console.log(`    ${line}`);
  if (truth !== null && record.winReason === "TERRITORY") {
    console.log(`    actual final margin from the AI's side: ${truth}`);
  }
  console.log(
    `  final influence (open ground each side reaches): A ${influence.A}, B ${influence.B}`,
  );

  if (declined.length > 0) {
    // Counted by distinct point, because the raw turn count badly overstates
    // this: one corner seal left alone for thirteen turns reads as thirteen
    // declined chances when it is one chance and twelve repeats of it.
    const distinct = new Map<string, { cells: number; turns: number[] }>();
    for (const d of declined) {
      const seen = distinct.get(d.best) ?? { cells: d.cells, turns: [] };
      seen.turns.push(d.turn);
      distinct.set(d.best, seen);
    }
    console.log(
      `\n  seals the AI passed up — ${distinct.size} distinct point(s)` +
        ` over ${declined.length} turns:`,
    );
    for (const [point, seen] of distinct) {
      const span =
        seen.turns.length === 1
          ? `turn ${seen.turns[0]}`
          : `turns ${seen.turns[0]}-${seen.turns[seen.turns.length - 1]}, ${seen.turns.length}x`;
      console.log(`    ${point}: ${seen.cells} cells, left alone on ${span}`);
    }
  }

  const timings = record.aiTimings ?? [];
  if (timings.length > 0) {
    const depths = timings.map((t) => t.depth);
    const slow = timings.filter((t) => t.elapsedMs >= t.budgetMs * 0.85).length;
    console.log(
      `  AI search: depth ${Math.min(...depths)}-${Math.max(...depths)}` +
        ` (median ${depths.slice().sort((a, b) => a - b)[Math.floor(depths.length / 2)]}),` +
        ` ${slow}/${timings.length} moves used the full budget`,
    );
  }
}
