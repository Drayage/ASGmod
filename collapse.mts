/**
 * Where does a game actually get lost?
 *
 * Game 1 of the app export is the useful one: the AI read itself 3.7 ahead at
 * turn 14 and 10.7 behind by turn 38. Something in between decided it, and the
 * margin trace alone cannot say what, because it moves on every ply and both
 * players move.
 *
 * So attribute it. Every ply changes the AI's own margin estimate; a ply is
 * either the AI's move or the human's reply. Summing the two separately answers
 * the question that decides where to look next:
 *
 *   loss on the AI's own moves    it is choosing badly, look at move selection
 *   loss on the human's replies   it is being outplayed, look at what it allows
 *
 * Both are stated from the AI's side, so negative is bad for the AI throughout.
 *
 *   npx vite-node collapse.mts <export.json> [game-number]
 */
import { readFileSync } from "node:fs";
import { applyAction, candidateActions, projectedMargin } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { BOARD_SIZE, opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

interface Move {
  turn: number;
  player: Player;
  type: string;
  row?: number;
  col?: number;
}
interface Record_ {
  playerSide: Player;
  winner: Player | null;
  winReason?: string;
  territoryA?: number;
  territoryB?: number;
  moveHistory: Move[];
}

const path = process.argv[2];
const which = Number(process.argv[3] ?? 1) - 1;
if (!path) throw new Error("usage: npx vite-node collapse.mts <export.json> [game-number]");
const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };
const record = parsed.records[which];

const COLUMNS = "ABCDEFGHI";
const name = (row: number, col: number) => `${COLUMNS[col]}${row + 1}`;
const human = record.playerSide;
const ai = opponent(human);

function render(state: GameState): string {
  const lines = [`     ${[...COLUMNS].join(" ")}`];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const cells = [];
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = state.board[row][col];
      cells.push(
        cell === "PLAYER_A" ? "A" : cell === "PLAYER_B" ? "B" : cell === "NEUTRAL" ? "#" : ".",
      );
    }
    lines.push(`  ${String(row + 1).padStart(2)} ${cells.join(" ")}`);
  }
  return lines.join("\n");
}

interface Ply {
  turn: number;
  by: "ai" | "human";
  move: string;
  before: number;
  after: number;
  delta: number;
}

const plies: Ply[] = [];
let state: GameState = createInitialState();
const boards = new Map<number, GameState>();

for (const move of record.moveHistory) {
  if (state.winner) break;
  const mover = state.currentPlayer;
  const before = projectedMargin(state, ai);
  boards.set(move.turn, state);
  const next =
    move.type === "PASS"
      ? applyAction(state, { type: "PASS" })
      : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
  const after = projectedMargin(next, ai);
  plies.push({
    turn: move.turn,
    by: mover === ai ? "ai" : "human",
    move: move.type === "PLACE" ? name(move.row!, move.col!) : "PASS",
    before,
    after,
    delta: after - before,
  });
  state = next;
}

console.log(`game ${which + 1}: human ${human}, AI ${ai} — ${record.winReason}, ` +
  `A ${record.territoryA} : B ${record.territoryB}\n`);

const sum = (by: "ai" | "human") =>
  plies.filter((p) => p.by === by).reduce((s, p) => s + p.delta, 0);
console.log(`total change in the AI's own margin over the game, split by whose move it was:`);
console.log(`  on the AI's own moves:   ${sum("ai").toFixed(1)}`);
console.log(`  on the human's replies:  ${sum("human").toFixed(1)}`);

console.log(`\nply by ply (margin from the AI's side, so negative is bad for it):`);
console.log(
  `${"turn".padStart(6)}${"by".padStart(8)}${"move".padStart(7)}` +
    `${"margin".padStart(9)}${"change".padStart(9)}`,
);
for (const p of plies) {
  const mark = p.delta <= -1.5 ? "  <<<" : "";
  console.log(
    `${String(p.turn).padStart(6)}${p.by.padStart(8)}${p.move.padStart(7)}` +
      `${p.after.toFixed(1).padStart(9)}${p.delta.toFixed(1).padStart(9)}${mark}`,
  );
}

/**
 * The single worst ply for the AI, and the position it faced going into it.
 * If the worst plies are the human's, print what the AI had just allowed.
 */
const worst = [...plies].sort((a, b) => a.delta - b.delta).slice(0, 5);
console.log(`\nthe five plies that cost the AI most:`);
for (const p of worst) {
  console.log(`  turn ${p.turn} (${p.by}) ${p.move}: ${p.delta.toFixed(1)}`);
}

const focus = worst[0];
const at = boards.get(focus.turn)!;
console.log(`\nposition before turn ${focus.turn} (${focus.by} played ${focus.move}):`);
console.log(render(at));
const seals = findSealingMoves(at, ai).filter((s) => s.gained.length >= 2);
console.log(
  `\n  2+ seals available to the AI here: ${
    seals.length === 0
      ? "none"
      : seals.map((s) => `${name(s.move.row, s.move.col)} (${s.gained.length})`).join(", ")
  }`,
);

/**
 * The question the split above cannot answer.
 *
 * "Gains on its own move, loses more on the reply" is what minimax does by
 * construction: the AI picks the move its evaluation likes best, so its own ply
 * always scores well and the opponent's ply always corrects it. The number is
 * not evidence of anything on its own.
 *
 * What is evidence: whether the human's big move was preventable. For each ply
 * that cost the AI most, go back to the AI's move immediately before it and try
 * every legal alternative, scoring each by the human's best reply. If some
 * other AI move would have held the loss down, the AI had a defensive resource
 * and missed it — a real, fixable defect. If every move loses about the same,
 * the position was already gone and the mistake was earlier.
 */
function bestReplyMargin(from: GameState): number {
  let worstForAi = Infinity;
  for (const action of candidateActions(from, from.currentPlayer)) {
    const next = applyAction(from, action);
    const margin = projectedMargin(next, ai);
    if (margin < worstForAi) worstForAi = margin;
  }
  return worstForAi === Infinity ? projectedMargin(from, ai) : worstForAi;
}

console.log(`\n\ncould the AI have prevented its three worst plies?`);
for (const p of worst.filter((w) => w.by === "human").slice(0, 3)) {
  const aiTurn = p.turn - 1;
  const from = boards.get(aiTurn);
  const played = plies.find((q) => q.turn === aiTurn);
  if (!from || !played) continue;

  let bestMove = "";
  let bestOutcome = -Infinity;
  for (const action of candidateActions(from, ai)) {
    const outcome = bestReplyMargin(applyAction(from, action));
    if (outcome > bestOutcome) {
      bestOutcome = outcome;
      bestMove =
        action.type === "PLACE" ? name(action.row, action.col) : "PASS";
    }
  }
  const actual = bestReplyMargin(
    applyAction(
      from,
      played.move === "PASS"
        ? { type: "PASS" }
        : { type: "PLACE", row: parseRow(played.move), col: parseCol(played.move) },
    ),
  );

  console.log(
    `  turn ${aiTurn}: AI played ${played.move} → best human reply leaves ${actual.toFixed(1)}`,
  );
  console.log(
    `           best available was ${bestMove} → leaves ${bestOutcome.toFixed(1)}` +
      `   (${(bestOutcome - actual).toFixed(1)} better)`,
  );
}

function parseRow(point: string): number {
  return Number(point.slice(1)) - 1;
}
function parseCol(point: string): number {
  return COLUMNS.indexOf(point[0]);
}
