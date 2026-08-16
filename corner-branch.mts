/**
 * "Why not here?" — score every alternative at one point in a corner line.
 *
 * corner-solver.mts answers "which reply to the opening is best"; this answers
 * the question that comes next while reading a record: at move N, what happens
 * if the side to move plays somewhere else instead? Every legal point in the
 * corner is scored, so a hunch about a killing move either shows up as a
 * capture or is priced in cells.
 *
 *   LINE=C2,A2,B1,D1,C1,B2 npx vite-node corner-branch.mts
 *   LINE=... PLY=6 npx vite-node corner-branch.mts     # cut the line short first
 *   LINE=... JSON=1 npx vite-node corner-branch.mts
 *
 * The line is written from B's first stone, alternating B, A, B, A, ... — the
 * same order the viewer numbers moves in. Scores stay in A's favour (A's corner
 * cells minus B's, +-99 for a capture) whichever side is to move, so a number
 * going down is always good for B.
 */
import { PASS, REGION, boardWith, cells, nm, parsePoint, search } from "./corner-core";
import { applyMove, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DEPTH = Number(process.env.DEPTH ?? 10);
const BUDGET = Number(process.env.BUDGET ?? 6);
const LINE = (process.env.LINE ?? "C2,A2,B1,D1,C1,B2").split(",").map((s) => s.trim()).filter(Boolean);
const PLY = Number(process.env.PLY ?? LINE.length);
const asJson = process.env.JSON === "1";

/** B plays the odd-numbered moves, A the even ones. */
const sideAt = (ply: number): Player => (ply % 2 === 1 ? "B" : "A");

let state: GameState = boardWith([]);
const played: Array<{ side: Player; point: string }> = [];
let passes = 0;
for (let i = 0; i < Math.min(PLY, LINE.length); i += 1) {
  const side = sideAt(i + 1);
  if (LINE[i].toLowerCase() === PASS) {
    played.push({ side, point: PASS });
    passes += 1;
    continue;
  }
  const { row, col } = parsePoint(LINE[i]);
  if (!isLegalMove(state, row, col, side)) {
    throw new Error(`move ${i + 1} (${side}:${LINE[i]}) is not legal in this position`);
  }
  state = applyMove({ ...state, currentPlayer: side }, row, col);
  played.push({ side, point: LINE[i] });
  passes = 0;
  if (state.winner) break;
}

if (state.winner) {
  console.log(`the line ends at move ${played.length}: ${state.winner} captures. Nothing to branch.`);
  process.exit(0);
}

const toMove = sideAt(played.length + 1);
// B's opening comes out of B's own budget, so neither side gets a free stone.
const spent = (p: Player) => played.filter((m) => m.side === p && m.point !== PASS).length;
const budgets: Record<Player, number> = {
  A: BUDGET - spent("A"),
  B: BUDGET - spent("B"),
};

const options = cells
  .filter((c) => isLegalMove(state, c.row, c.col, toMove))
  .map((c) => {
    const next = applyMove({ ...state, currentPlayer: toMove }, c.row, c.col);
    if (next.winner) {
      return { name: nm(c.row, c.col), score: next.winner === "A" ? 99 : -99, line: ["(captures)"] };
    }
    const { score, line } = search(
      next,
      "A",
      opponent(toMove),
      { ...budgets, [toMove]: budgets[toMove] - 1 },
      DEPTH,
      -Infinity,
      Infinity,
      new Map(),
      0,
    );
    return { name: nm(c.row, c.col), score, line };
  })
  // Best first for whoever is to move: A wants the score up, B wants it down.
  .sort((x, y) => (toMove === "A" ? y.score - x.score : x.score - y.score));

const header = played.map((m, i) => `${i + 1}.${m.side}:${m.point}`).join(" ");
const asPlayed = LINE[played.length];

if (asJson) {
  console.log(JSON.stringify({ line: played, toMove, budgets, asPlayed, options }));
} else {
  console.log(`corner branch — the ${REGION + 1}x${REGION + 1} corner, ${BUDGET} stones a side, depth ${DEPTH}, pass allowed`);
  console.log(`after ${played.length} moves: ${header}`);
  console.log(`move ${played.length + 1} is ${toMove}'s` +
    (asPlayed ? ` (played ${asPlayed} in the record)` : "") +
    `; ${toMove} has ${budgets[toMove]} stone(s) left, ${opponent(toMove)} has ${budgets[opponent(toMove)]}.`);
  console.log(`score is A's corner cells minus B's — lower is better for B.\n`);
  console.log(`${"move".padEnd(8)}${"A - B".padStart(7)}   continuation (best play by both)`);
  for (const o of options) {
    const mark = o.name === asPlayed ? " <- record" : "";
    console.log(
      `${o.name.padEnd(8)}${o.score.toFixed(0).padStart(7)}   ${o.line.join(" ")}${mark}`,
    );
  }
}
