/**
 * What a productive approach looks like.
 *
 * rival-corner settled the frequency question: the engine goes into the
 * opponent's corners more often than the player does, 2.21 times a game to 1.36,
 * and comes out with 0.9 cells to the player's 2.4. So the gap is not whether to
 * go in, it is what happens next.
 *
 * This follows each approach forward. How many more stones does the approacher
 * spend in that quadrant, where do they go relative to the first one, and how
 * far from the board edge do they sit — then splits every approach by whether it
 * ended up owning anything at all, so the productive ones can be told apart from
 * the rest by something other than who played them.
 *
 *   npx vite-node approach-shape.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const cornerOf = (row: number, col: number) =>
  row === 4 || col === 4 ? null : `${row < 4 ? "T" : "B"}${col < 4 ? "L" : "R"}`;
/** Distance to the nearer edge on each axis, sorted — the corner class. */
const classOf = (row: number, col: number) => {
  const a = Math.min(row, 8 - row);
  const b = Math.min(col, 8 - col);
  return `(${Math.min(a, b)},${Math.max(a, b)})`;
};

interface Approach {
  side: string;
  /** Stones the approacher added to the quadrant after the first one. */
  follow: number;
  /** Of those, how many touched an earlier stone of theirs diagonally. */
  diagonal: number;
  /** ... and orthogonally. */
  straight: number;
  /** Nearest-edge distance of the approach stone itself. */
  edge: number;
  cls: string;
  gained: number;
}

const all: Approach[] = [];
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const nameOf = (p: Player) => (p === human ? "human" : "ai");

    const opener = new Map<string, Player>();
    const approach = new Map<string, { by: Player; at: Approach }>();

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const prev = state;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (m.type !== "PLACE") continue;
      const corner = cornerOf(m.row, m.col);
      if (!corner) continue;

      const held = opener.get(corner);
      if (held === undefined) {
        opener.set(corner, mover);
        continue;
      }
      if (mover === held) continue;

      const entered = approach.get(corner);
      if (entered === undefined) {
        const at: Approach = {
          side: nameOf(mover),
          follow: 0,
          diagonal: 0,
          straight: 0,
          edge: Math.min(m.row!, 8 - m.row!, m.col!, 8 - m.col!),
          cls: classOf(m.row!, m.col!),
          gained: 0,
        };
        approach.set(corner, { by: mover, at });
        all.push(at);
        continue;
      }
      if (entered.by !== mover) continue;

      // A later stone of the approacher's, in the same quadrant. How it relates
      // to what they already had there is the shape question.
      entered.at.follow += 1;
      const mine = playerCell(mover);
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const r = m.row! + dr;
        const c = m.col! + dc;
        if (r < 0 || r > 8 || c < 0 || c > 8) continue;
        if (prev.board[r][c] === mine && cornerOf(r, c) === corner) {
          entered.at.straight += 1;
          break;
        }
      }
      for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const r = m.row! + dr;
        const c = m.col! + dc;
        if (r < 0 || r > 8 || c < 0 || c > 8) continue;
        if (prev.board[r][c] === mine && cornerOf(r, c) === corner) {
          entered.at.diagonal += 1;
          break;
        }
      }
    }

    for (const [corner, entered] of approach) {
      entered.at.gained = state.territories[entered.by].filter(
        (c: { row: number; col: number }) => cornerOf(c.row, c.col) === corner,
      ).length;
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const rate = (xs: Approach[], f: (a: Approach) => number) =>
  mean(xs.map(f)).toFixed(2);

function row(label: string, xs: Approach[]): void {
  if (xs.length === 0) return;
  console.log(
    `${label.padEnd(20)}${String(xs.length).padStart(7)}${rate(xs, (a) => a.follow).padStart(11)}` +
      `${rate(xs, (a) => a.diagonal).padStart(11)}${rate(xs, (a) => a.straight).padStart(11)}` +
      `${rate(xs, (a) => a.edge).padStart(9)}${rate(xs, (a) => a.gained).padStart(9)}`,
  );
}

console.log(`what happens after the approach, ${all.length} approaches\n`);
console.log(
  `${"group".padEnd(20)}${"n".padStart(7)}${"follow-ups".padStart(11)}` +
    `${"diagonal".padStart(11)}${"straight".padStart(11)}${"edge".padStart(9)}${"kept".padStart(9)}`,
);
row("human", all.filter((a) => a.side === "human"));
row("ai", all.filter((a) => a.side === "ai"));
console.log();
row("kept nothing", all.filter((a) => a.gained === 0));
row("kept 1-2", all.filter((a) => a.gained >= 1 && a.gained <= 2));
row("kept 3+", all.filter((a) => a.gained >= 3));

console.log(`\nwhere the approach stone lands`);
for (const side of ["human", "ai"]) {
  const xs = all.filter((a) => a.side === side);
  const tally = new Map<string, number>();
  for (const a of xs) tally.set(a.cls, (tally.get(a.cls) ?? 0) + 1);
  const parts = [...tally.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5)
    .map(([k, v]) => `${k} ${Math.round((100 * v) / xs.length)}%`);
  console.log(`  ${side.padEnd(8)}${parts.join("   ")}`);
}

// Follow-up counts and yield are contemporaneous — a group that got sealed or
// died cannot go on adding stones — so they cannot separate cause from effect.
// The landing point is different: it is chosen before anything happens to it.
// Split within each side so the comparison is not just human versus engine.
console.log(`\nyield by where the approach landed, within each side`);
console.log(
  `${"side".padEnd(8)}${"point".padStart(9)}${"n".padStart(6)}${"kept".padStart(8)}` +
    `${"follow-ups".padStart(12)}${"diagonal".padStart(10)}`,
);
for (const side of ["human", "ai"]) {
  const xs = all.filter((a) => a.side === side);
  for (const [label, pick] of [
    ["(1,2)", (a: Approach) => a.cls === "(1,2)"],
    ["other", (a: Approach) => a.cls !== "(1,2)"],
  ] as Array<[string, (a: Approach) => boolean]>) {
    const g = xs.filter(pick);
    if (g.length === 0) continue;
    console.log(
      `${side.padEnd(8)}${label.padStart(9)}${String(g.length).padStart(6)}` +
        `${rate(g, (a) => a.gained).padStart(8)}${rate(g, (a) => a.follow).padStart(12)}` +
        `${rate(g, (a) => a.diagonal).padStart(10)}`,
    );
  }
}

// The landing point turns out not to separate them, so the remaining candidate
// is the shape of the follow-ups. Restricting to approaches that got at least
// three of them holds survival roughly fixed — a group that was killed or sealed
// early cannot be in either bucket — and then the only thing varying is whether
// those stones went diagonally or straight.
console.log(`\napproaches with 3+ follow-ups, split by how they connected`);
console.log(
  `${"side".padEnd(8)}${"connections".padStart(18)}${"n".padStart(6)}` +
    `${"diagonal share".padStart(16)}${"kept".padStart(16)}`,
);
for (const side of ["human", "ai"]) {
  const xs = all.filter((a) => a.side === side && a.follow >= 3);
  const shareOf = (a: Approach) =>
    a.diagonal + a.straight === 0 ? 0 : a.diagonal / (a.diagonal + a.straight);
  for (const [label, pick] of [
    ["mostly diagonal", (a: Approach) => shareOf(a) >= 0.6],
    ["mixed or straight", (a: Approach) => shareOf(a) < 0.6],
  ] as Array<[string, (a: Approach) => boolean]>) {
    const g = xs.filter(pick);
    if (g.length === 0) continue;
    const kept = g.map((a) => a.gained);
    const m = mean(kept);
    const sd = Math.sqrt(mean(kept.map((k) => (k - m) ** 2)) * (kept.length / (kept.length - 1)));
    const half = (1.96 * sd) / Math.sqrt(kept.length);
    console.log(
      `${side.padEnd(8)}${label.padStart(18)}${String(g.length).padStart(6)}` +
        `${mean(g.map(shareOf)).toFixed(2).padStart(16)}` +
        `${`${m.toFixed(2)} +/- ${half.toFixed(2)}`.padStart(16)}`,
    );
  }
}

console.log(`\nhow much the approach group grows, by side`);
for (const side of ["human", "ai"]) {
  const xs = all.filter((a) => a.side === side);
  const tally = new Map<number, number>();
  for (const a of xs) tally.set(Math.min(a.follow, 5), (tally.get(Math.min(a.follow, 5)) ?? 0) + 1);
  const parts = [...tally.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([k, v]) => `${k === 5 ? "5+" : k} ${Math.round((100 * v) / xs.length)}%`);
  console.log(`  ${side.padEnd(8)}${parts.join("   ")}`);
}
