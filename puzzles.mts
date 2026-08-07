/**
 * Four life-and-death problems from the game's own publisher, put to the
 * engine's capture reader.
 *
 * Transcribed from the published diagram by sampling each cell against a grid
 * anchored on the neutral centre point, so the reading is machine-made rather
 * than eyeballed. Each is captioned 파랑선 주황사 — blue to play, orange dies —
 * which is exactly the question `findForcedCapture` answers, and a capture in
 * this game is an outright win, so a solved problem is a won game.
 *
 * Worth doing on its own terms: these are human-authored positions with known
 * answers, and nothing in this repository has ever checked the tactical reader
 * against a source outside itself.
 *
 *   npx vite-node puzzles.mts
 */
import {
  findForcedCapture,
  setCaptureRetargets,
  getCaptureRetargets,
} from "./src/games/alley-boss-cats/engine/captureSearch";
import { getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { getAllGroups, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { BOARD_SIZE, CENTER, STARTING_CATS, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, GameState, Player } from "./src/games/alley-boss-cats/types";

const COLUMNS = "ABCDEFGHI";

/** Blue plays first in every problem, so blue is A. */
const BLUE: Player = "A";
const ORANGE: Player = "B";

interface Puzzle {
  name: string;
  blue: string[];
  orange: string[];
}

/** First move of the published answer, recovered from the answer diagrams. */
const ANSWERS: Record<string, string> = {
  "1 (top left)": "F8",
  "2 (top right)": "B8",
  "3 (bottom left)": "F8",
  // D7, not the E8 I first read off the answer diagram: D7 is the shared
  // liberty of {D6} and {E7}, and confirmed by the author. E8 is blue's
  // second move.
  "4 (bottom right)": "D7",
};

const PUZZLES: Puzzle[] = [
  { name: "1 (top left)", blue: ["E7", "D8", "D9"], orange: ["F7", "E8", "E9"] },
  { name: "2 (top right)", blue: ["B3", "B6", "A8"], orange: ["B7", "B9"] },
  { name: "3 (bottom left)", blue: ["F6", "D7", "E7", "C8"], orange: ["F7", "D8", "E8", "C9"] },
  { name: "4 (bottom right)", blue: ["C6", "E6", "F6"], orange: ["C5", "D6", "E7"] },
];

function parse(point: string): { row: number; col: number } {
  const col = COLUMNS.indexOf(point[0].toUpperCase());
  const row = Number(point.slice(1)) - 1;
  if (col < 0 || row < 0 || row >= BOARD_SIZE) throw new Error(`bad point ${point}`);
  return { row, col };
}
const name = (row: number, col: number) => `${COLUMNS[col]}${row + 1}`;

function build(puzzle: Puzzle, toMove: Player): GameState {
  const board: Board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill("EMPTY"));
  board[CENTER][CENTER] = "NEUTRAL";
  for (const point of puzzle.blue) {
    const { row, col } = parse(point);
    board[row][col] = playerCell(BLUE);
  }
  for (const point of puzzle.orange) {
    const { row, col } = parse(point);
    board[row][col] = playerCell(ORANGE);
  }
  return {
    board,
    currentPlayer: toMove,
    remainingCats: { A: STARTING_CATS - puzzle.blue.length, B: STARTING_CATS - puzzle.orange.length },
    consecutivePasses: 0,
    territories: { A: [], B: [] },
    winner: null,
    winReason: null,
    moveHistory: [],
  };
}

function render(state: GameState): string {
  const lines = [`   ${[...COLUMNS].join(" ")}`];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const cells = [];
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = state.board[row][col];
      cells.push(cell === "PLAYER_A" ? "B" : cell === "PLAYER_B" ? "O" : cell === "NEUTRAL" ? "#" : ".");
    }
    lines.push(`${String(row + 1).padStart(2)} ${cells.join(" ")}`);
  }
  return lines.join("\n");
}

function groupsOf(state: GameState, player: Player) {
  return getAllGroups(state.board, player).map((group) => ({
    stones: group.map((s) => name(s.row, s.col)).sort(),
    liberties: [...getGroupLiberties(state.board, group)]
      .map((key) => {
        const [row, col] = key.split(",").map(Number);
        return name(row, col);
      })
      .sort(),
  }));
}

const DEPTH = Number(process.env.DEPTH ?? 10);
const BUDGET = Number(process.env.BUDGET ?? 20000);
// Only override when asked. Left alone, this reports what the engine actually
// reads with, so the run is a statement about shipped behaviour rather than
// about whatever this file happened to default to.
if (process.env.RETARGETS !== undefined) setCaptureRetargets(Number(process.env.RETARGETS));
console.log(`captureRetargets = ${getCaptureRetargets()}, depth ${DEPTH}, budget ${BUDGET}ms`);

for (const puzzle of PUZZLES) {
  const state = build(puzzle, BLUE);
  console.log(`\n=== problem ${puzzle.name} — blue (B) to play, orange (O) must die ===`);
  console.log(render(state));

  console.log("  orange groups:");
  for (const group of groupsOf(state, ORANGE)) {
    console.log(`    {${group.stones.join(" ")}}  ${group.liberties.length} liberties: ${group.liberties.join(" ")}`);
  }

  const started = Date.now();
  const forced = findForcedCapture(state, BLUE, DEPTH, BUDGET);
  const took = Date.now() - started;

  if (forced) {
    const move = forced.move.type === "PLACE" ? name(forced.move.row, forced.move.col) : "PASS";
    const published = ANSWERS[puzzle.name];
    console.log(
      `  engine: ${move} (${took}ms) — published answer ${published}` +
        `${move === published ? "  MATCH" : "  different move, may still win"}`,
    );
  } else {
    console.log(`  engine: nothing at depth ${DEPTH} in ${took}ms — published answer ${ANSWERS[puzzle.name]}  MISS`);
    // Say something useful about why rather than just failing.
    const legal = getLegalMoves(state, BLUE).length;
    console.log(`  (${legal} legal blue moves searched)`);
  }
}

/**
 * A second opinion, because "the engine found nothing" and "there is nothing"
 * are different claims.
 *
 * `findForcedCapture` is built for a search that must also do everything else
 * within a move's budget, so it narrows hard. This does the same job with a
 * wider net: every legal move within two points of a stone, alpha-beta over
 * both sides, and a capture by *either* side ends the line — the defender
 * capturing is a loss for the attacker, since a capture wins outright here.
 */
import { applyMove } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";

function nearStones(state: GameState, player: Player, reach = 2): Array<{ row: number; col: number }> {
  const out: Array<{ row: number; col: number }> = [];
  for (const move of getLegalMoves(state, player)) {
    let near = false;
    for (let dr = -reach; dr <= reach && !near; dr += 1) {
      for (let dc = -reach; dc <= reach && !near; dc += 1) {
        const r = move.row + dr;
        const c = move.col + dc;
        if (r < 0 || c < 0 || r >= BOARD_SIZE || c >= BOARD_SIZE) continue;
        const cell = state.board[r][c];
        if (cell === "PLAYER_A" || cell === "PLAYER_B") near = true;
      }
    }
    if (near) out.push(move);
  }
  return out;
}

const key = (state: GameState) =>
  `${state.currentPlayer}|${state.board.map((row) => row.join("")).join("")}`;

/** True if `attacker` (to move) can force a capture within `depth` plies. */
function attackerWins(
  state: GameState,
  attacker: Player,
  depth: number,
  memo: Map<string, boolean>,
): { win: boolean; move?: { row: number; col: number } } {
  if (depth <= 0) return { win: false };
  const mover = state.currentPlayer;
  const cacheKey = `${depth}|${key(state)}`;
  const cached = memo.get(cacheKey);
  if (cached !== undefined) return { win: cached };

  const moves = nearStones(state, mover);
  if (moves.length === 0) return { win: false };

  let result = mover !== attacker; // defender: all moves must lose for it to be a win
  let best: { row: number; col: number } | undefined;

  for (const move of moves) {
    const next = applyMove(state, move.row, move.col);
    let win: boolean;
    if (next.winner) win = next.winner === attacker;
    else win = attackerWins(next, attacker, depth - 1, memo).win;

    if (mover === attacker) {
      if (win) {
        result = true;
        best = move;
        break;
      }
    } else if (!win) {
      result = false;
      break;
    }
  }
  memo.set(cacheKey, result);
  return { win: result, move: best };
}

/**
 * Unbudgeted on purpose — the point is to answer "is there anything there?"
 * without a clock deciding for us, and problem 3 has taken 52 seconds. That
 * makes it easy to leave running by accident, so `DEEP=0` skips it and the
 * reader's own results, which are what the engine actually does, print first
 * and alone.
 */
const DEEP = Number(process.env.DEEP ?? 7);
if (DEEP > 0) runSecondOpinion();

function runSecondOpinion(): void {
console.log(`\n\n=== second opinion: wide alpha-beta to ${DEEP} plies ===`);
for (const puzzle of PUZZLES) {
  const state = build(puzzle, BLUE);
  const started = Date.now();
  let answer: { win: boolean; move?: { row: number; col: number } } = { win: false };
  for (let depth = 1; depth <= DEEP; depth += 2) {
    answer = attackerWins(state, BLUE, depth, new Map());
    if (answer.win) {
      console.log(
        `  ${puzzle.name}: blue ${answer.move ? name(answer.move.row, answer.move.col) : "?"} ` +
          `forces a capture in ${depth} plies (${Date.now() - started}ms)`,
      );
      break;
    }
  }
  if (!answer.win) console.log(`  ${puzzle.name}: nothing forced within ${DEEP} plies (${Date.now() - started}ms)`);
}
}
