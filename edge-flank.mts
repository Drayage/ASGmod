/**
 * Is "enemy beside the edge point" a real exception, or two lucky cells?
 *
 * §66 rejected the player's condition — one enemy stone anywhere does not make
 * the edge extension better — but two placements went the other way and they
 * were the two cells flanking (0,3) along the edge: with the enemy there, the
 * edge extension killed the invader at every entry point and the middle one did
 * not. Two of twelve is not a rule, so nothing was changed.
 *
 * The corner has two edges, so the same claim can be asked again on the other
 * one and the sample doubled without inventing anything. From the (1,2) point
 * the extensions are (2,1) middle and (0,3) edge, and the flanking cells are
 * (0,2) and (0,4); from the (2,1) point they are (1,2) middle and (3,0) edge,
 * with flanking cells (2,0) and (4,0). If the pattern is real it appears on both
 * and only beside the edge point; if it is noise it will not survive the mirror.
 *
 *   npx vite-node edge-flank.mts
 */
import { findForcedCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { createInitialState, getLegalMoves, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const REACH = Number(process.env.REACH ?? 4);
const COLS = "ABCDEFGHI";
const nm = (row: number, col: number) => `${COLS[col]}${row + 1}`;

type Pt = [number, number];

function build(mine: Pt[], theirs: Pt[], toMove: Player): GameState {
  const base = createInitialState();
  const board = base.board.map((r) => [...r]);
  for (const [r, c] of mine) board[r][c] = playerCell("A");
  for (const [r, c] of theirs) board[r][c] = playerCell("B");
  return { ...base, board, territories: calculateTerritories(board), currentPlayer: toMove };
}

const local = (state: GameState, side: Player) =>
  getLegalMoves(state, side).filter((m) => m.row + m.col <= REACH);

/** Entry points inside the corner where a second enemy stone survives. */
function leak(mine: Pt[], enemy: Pt): { lives: number; entries: number } {
  const after = build(mine, [enemy], "B");
  let lives = 0;
  let entries = 0;
  for (const mv of local(after, "B")) {
    if (mv.row + mv.col > 3) continue;
    entries += 1;
    const invaded = build(mine, [enemy, [mv.row, mv.col]], "A");
    if (findForcedCapture({ ...invaded, currentPlayer: "A" }, "A", 9, 1200) === null) lives += 1;
  }
  return { lives, entries };
}

/** Each way of holding one frame stone, with its middle and edge extension. */
const setups: Array<{ from: Pt; middle: Pt; edge: Pt; flanks: Pt[]; others: Pt[] }> = [
  {
    from: [1, 2],
    middle: [2, 1],
    edge: [0, 3],
    flanks: [[0, 2], [0, 4]],
    others: [[1, 3], [2, 2], [0, 0], [2, 0], [3, 1], [1, 1]],
  },
  {
    from: [2, 1],
    middle: [1, 2],
    edge: [3, 0],
    flanks: [[2, 0], [4, 0]],
    others: [[3, 1], [2, 2], [0, 0], [0, 2], [1, 3], [1, 1]],
  },
];

console.log(`the edge extension, with the enemy beside it and elsewhere\n`);
console.log(
  `${"hold".padStart(6)}${"enemy".padStart(8)}${"where".padStart(9)}` +
    `${"middle leaks".padStart(14)}${"edge leaks".padStart(13)}${"better".padStart(9)}`,
);

const tally: Record<string, { middle: number; edge: number; level: number }> = {
  flank: { middle: 0, edge: 0, level: 0 },
  elsewhere: { middle: 0, edge: 0, level: 0 },
};

for (const s of setups) {
  for (const [label, spots] of [["flank", s.flanks], ["elsewhere", s.others]] as Array<[string, Pt[]]>) {
    for (const enemy of spots) {
      const base = build([s.from], [enemy], "A");
      if (!isLegalMove(base, s.middle[0], s.middle[1], "A")) continue;
      if (!isLegalMove(base, s.edge[0], s.edge[1], "A")) continue;
      const m = leak([s.from, s.middle], enemy);
      const e = leak([s.from, s.edge], enemy);
      const mr = m.entries ? m.lives / m.entries : 0;
      const er = e.entries ? e.lives / e.entries : 0;
      const better = mr < er ? "middle" : er < mr ? "edge" : "level";
      tally[label][better as "middle" | "edge" | "level"] += 1;
      console.log(
        `${nm(s.from[0], s.from[1]).padStart(6)}${nm(enemy[0], enemy[1]).padStart(8)}` +
          `${label.padStart(9)}${`${m.lives}/${m.entries}`.padStart(14)}` +
          `${`${e.lives}/${e.entries}`.padStart(13)}${better.padStart(9)}`,
      );
    }
  }
}

console.log();
for (const [label, t] of Object.entries(tally)) {
  console.log(
    `${label.padEnd(10)} middle better ${t.middle}, edge better ${t.edge}, level ${t.level}`,
  );
}

// The book does not even reach the frame sort in the flank case: an enemy stone
// touching our (1,2) stone makes it `pressed`, and it takes the small eye —
// the two edge points either side. So the choice that actually happens there is
// between those two, not between middle and edge, and that is what to measure.
console.log(`\nthe pressed case: which edge point, with the enemy flanking\n`);
console.log(
  `${"hold".padStart(6)}${"enemy".padStart(8)}${"near side".padStart(12)}` +
    `${"far side".padStart(12)}${"better".padStart(9)}`,
);
const pressedCases: Array<{ from: Pt; near: Pt; far: Pt; enemy: Pt }> = [
  { from: [1, 2], near: [0, 1], far: [0, 3], enemy: [0, 2] },
  { from: [1, 2], near: [0, 3], far: [0, 1], enemy: [0, 4] },
  { from: [2, 1], near: [1, 0], far: [3, 0], enemy: [2, 0] },
  { from: [2, 1], near: [3, 0], far: [1, 0], enemy: [4, 0] },
];
for (const c of pressedCases) {
  const base = build([c.from], [c.enemy], "A");
  if (!isLegalMove(base, c.near[0], c.near[1], "A")) continue;
  if (!isLegalMove(base, c.far[0], c.far[1], "A")) continue;
  const n = leak([c.from, c.near], c.enemy);
  const f = leak([c.from, c.far], c.enemy);
  const nr = n.entries ? n.lives / n.entries : 0;
  const fr = f.entries ? f.lives / f.entries : 0;
  console.log(
    `${nm(c.from[0], c.from[1]).padStart(6)}${nm(c.enemy[0], c.enemy[1]).padStart(8)}` +
      `${`${n.lives}/${n.entries}`.padStart(12)}${`${f.lives}/${f.entries}`.padStart(12)}` +
      `${(nr < fr ? "near" : fr < nr ? "far" : "level").padStart(9)}`,
  );
}
