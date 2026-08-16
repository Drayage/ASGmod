/**
 * Turn the corner solver's JSON runs into the blob the review page reads.
 *
 * The solver prints one object per opening (JSON=1). That object carries the
 * variation as move tags, which is enough to draw a game record but not enough
 * to draw the *result* — so this replays each variation through the real rules
 * and attaches the territory each side ends the corner with. Same rules the
 * game uses, so the page can never disagree with the engine about a position.
 *
 *   cat joseki-data.jsonl | npx vite-node joseki-page-data.mts > joseki-page.json
 */
import { readFileSync } from "node:fs";
import { applyMove, createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { getAllGroups, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const REGION = 3;
const COLS = "ABCDEFGHI";

type SolverAnswer = {
  name: string;
  point: string;
  row: number;
  col: number;
  score: number;
  line: string[];
};
type SolverRun = {
  opening: { a: number; b: number; name: string };
  budget: number;
  depth: number;
  answers: SolverAnswer[];
};

/**
 * "B:C2", "A:D1 (captures)" or "B:pass" -> the side, the cell, and whether it
 * ends the game. A pass carries no cell: either side may decline to add a stone,
 * and two in a row settle the corner.
 */
function parseTag(tag: string): {
  side: Player;
  row: number;
  col: number;
  captures: boolean;
  pass: boolean;
} {
  const [side, rest] = tag.split(":");
  const point = rest.trim().split(" ")[0];
  if (point === "pass") {
    return { side: side as Player, row: -1, col: -1, captures: false, pass: true };
  }
  const col = COLS.indexOf(point[0]);
  const row = Number(point.slice(1)) - 1;
  return { side: side as Player, row, col, captures: tag.includes("captures"), pass: false };
}

const input = readFileSync(process.argv[2] ?? 0, "utf8");
const runs: SolverRun[] = input
  .split("\n")
  .filter((l) => l.trim().startsWith("{"))
  .map((l) => JSON.parse(l));

const inCorner = (c: { row: number; col: number }) => c.row <= REGION && c.col <= REGION;

function replay(line: string[]) {
  let state: GameState = createInitialState();
  const moves: Array<{
    side: Player;
    row: number;
    col: number;
    captures: boolean;
    pass: boolean;
    caught?: Array<[number, number]>;
    illegal?: true;
  }> = [];
  for (const tag of line) {
    const mv = parseTag(tag);
    if (mv.pass) {
      moves.push(mv);
      continue;
    }
    if (!isLegalMove(state, mv.row, mv.col, mv.side)) {
      moves.push({ ...mv, illegal: true });
      break;
    }
    state = applyMove({ ...state, currentPlayer: mv.side }, mv.row, mv.col);
    // The rules end the game on a capture rather than lifting the stones, so
    // the surrounded group is still on the board — find it, so the diagram can
    // mark exactly which cats were caught instead of just naming a winner.
    const caught = state.winner
      ? getAllGroups(state.board, opponent(mv.side))
          .filter((g) => getGroupLiberties(state.board, g).size === 0)
          .flat()
          .map((c) => [c.row, c.col] as [number, number])
      : undefined;
    moves.push(caught && caught.length > 0 ? { ...mv, caught } : mv);
    if (state.winner) break;
  }
  const terr = calculateTerritories(state.board);
  const own = (p: Player) => terr[p].filter(inCorner).map((c) => [c.row, c.col] as [number, number]);
  return {
    moves,
    winner: state.winner ?? null,
    territory: { A: own("A"), B: own("B") },
    cells: { A: own("A").length, B: own("B").length },
  };
}

const out = runs.map((run) => ({
  opening: run.opening,
  budget: run.budget,
  depth: run.depth,
  answers: run.answers.map((a) => {
    const replayed = replay(a.line);
    return {
      name: a.name,
      point: a.point,
      row: a.row,
      col: a.col,
      score: a.score,
      ...replayed,
    };
  }),
}));

// A quick consistency check on stderr: the replayed count should reproduce the
// solver's score, or the page would show a board that argues with its own label.
let mismatches = 0;
for (const run of out) {
  for (const a of run.answers) {
    if (a.winner === null && a.cells.A - a.cells.B !== a.score) mismatches += 1;
  }
}
console.error(
  `${out.length} openings, ${out.reduce((n, r) => n + r.answers.length, 0)} answers, ` +
    `${mismatches} score mismatches`,
);

console.log(JSON.stringify(out));
