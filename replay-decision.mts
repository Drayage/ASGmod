/**
 * Put the engine back in a position it lost from, and see what it plays now.
 *
 * `collapse.mts` finds moves that would have scored better on territory two
 * plies out. That is not the same claim as "the engine was wrong": it optimises
 * `evaluateState`, not `projectedMargin`, and it reads five to eight plies, not
 * two. A move that looks better on territory alone may hang a group, and a
 * capture loses outright here.
 *
 * So ask the engine itself. Replay the game to the position, run the real
 * VERY_HARD search at the real budget, and print what it picks — alongside what
 * it picked on the day and what the shallow territory analysis suggested.
 *
 *   npx vite-node replay-decision.mts <export.json> <game> <turn> [suggestion]
 */
import { readFileSync } from "node:fs";
import { applyAction, evaluateState, getSafeActions } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { projectedMargin } from "./src/games/alley-boss-cats/ai";
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
  moveHistory: Move[];
}

const [, , path, gameArg, turnArg, suggestion] = process.argv;
if (!path || !turnArg) {
  throw new Error("usage: npx vite-node replay-decision.mts <export.json> <game> <turn> [move]");
}
const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };
const record = parsed.records[Number(gameArg) - 1];
const targetTurn = Number(turnArg);

const COLUMNS = "ABCDEFGHI";
const name = (row: number, col: number) => `${COLUMNS[col]}${row + 1}`;
const parsePoint = (point: string) => ({
  row: Number(point.slice(1)) - 1,
  col: COLUMNS.indexOf(point[0].toUpperCase()),
});

const human = record.playerSide;
const ai = opponent(human);

let state: GameState = createInitialState();
let playedOnTheDay = "";
for (const move of record.moveHistory) {
  if (move.turn === targetTurn) {
    playedOnTheDay = move.type === "PLACE" ? name(move.row!, move.col!) : "PASS";
    break;
  }
  state =
    move.type === "PASS"
      ? applyAction(state, { type: "PASS" })
      : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
}

const lines = [`     ${[...COLUMNS].join(" ")}`];
for (let row = 0; row < BOARD_SIZE; row += 1) {
  const cells = [];
  for (let col = 0; col < BOARD_SIZE; col += 1) {
    const cell = state.board[row][col];
    cells.push(cell === "PLAYER_A" ? "A" : cell === "PLAYER_B" ? "B" : cell === "NEUTRAL" ? "#" : ".");
  }
  lines.push(`  ${String(row + 1).padStart(2)} ${cells.join(" ")}`);
}
console.log(`game ${gameArg}, before turn ${targetTurn} — ${ai} (the AI) to move\n`);
console.log(lines.join("\n"));
console.log(`\n  to move: ${state.currentPlayer}   (AI is ${ai})`);

const started = Date.now();
const choice = findBestMoveVeryHard(state, ai, 3000);
const took = Date.now() - started;
// Captured here: the opponent searches below overwrite it.
const decided = { ...lastDecision };
const chosen = choice.type === "PLACE" ? name(choice.row, choice.col) : "PASS";

console.log(`\n  played on the day:      ${playedOnTheDay}`);
console.log(`  engine at HEAD now:     ${chosen}   (${took}ms)`);
if (suggestion) console.log(`  territory analysis said: ${suggestion}`);

/**
 * What the engine's own objective says about each, so a disagreement between
 * the two-ply territory read and the real search can be attributed rather than
 * just noted.
 */
const { pool } = getSafeActions(state, ai);
const legal = new Set(
  pool.map((a) => (a.type === "PLACE" ? name(a.row, a.col) : "PASS")),
);
console.log(`\n  ${"move".padEnd(10)}${"legal?".padStart(8)}${"evaluateState".padStart(16)}${"projectedMargin".padStart(18)}`);
for (const point of [...new Set([playedOnTheDay, chosen, suggestion].filter(Boolean))] as string[]) {
  if (!legal.has(point)) {
    console.log(`  ${point.padEnd(10)}${"no".padStart(8)}${"—".padStart(16)}${"—".padStart(18)}`);
    continue;
  }
  const after = applyAction(
    state,
    point === "PASS" ? { type: "PASS" } : { type: "PLACE", ...parsePoint(point) },
  );
  console.log(
    `  ${point.padEnd(10)}${"yes".padStart(8)}` +
      `${evaluateState(after, ai).toFixed(0).padStart(16)}` +
      `${projectedMargin(after, ai).toFixed(1).padStart(18)}`,
  );
}

/**
 * The disagreement above, settled by the strongest reply available.
 *
 * A static score after one move says little, and a two-ply territory read says
 * little more, because the opponent's reply in both is a guess. So let the
 * engine itself supply it: play the candidate, run the full VERY_HARD search
 * for the *human* at the same budget, and score the position that comes back.
 * Whatever the search knows about the reply is then in the number, for both
 * candidates equally.
 */
console.log(`\n  each candidate, answered by a full-strength search for the opponent:`);
console.log(
  `  ${"move".padEnd(10)}${"human replies".padStart(16)}${"then eval".padStart(12)}` +
    `${"then margin".padStart(14)}`,
);
for (const point of [...new Set([playedOnTheDay, chosen, suggestion].filter(Boolean))] as string[]) {
  if (!legal.has(point)) continue;
  const after = applyAction(
    state,
    point === "PASS" ? { type: "PASS" } : { type: "PLACE", ...parsePoint(point) },
  );
  if (after.winner) {
    console.log(`  ${point.padEnd(10)}${"game over".padStart(16)}`);
    continue;
  }
  const reply = findBestMoveVeryHard(after, human, 3000);
  const then = applyAction(after, reply);
  console.log(
    `  ${point.padEnd(10)}` +
      `${(reply.type === "PLACE" ? name(reply.row, reply.col) : "PASS").padStart(16)}` +
      `${evaluateState(then, ai).toFixed(0).padStart(12)}` +
      `${projectedMargin(then, ai).toFixed(1).padStart(14)}`,
  );
}

// Which stage of the guard ladder actually decided this move. A shortlist stage
// returning here means the search never saw most of the pool.
console.log(
  `\n  decided by stage: ${decided.stage}` +
    `  (${decided.candidates} candidate(s) of ${decided.poolSize} in the pool)`,
);
