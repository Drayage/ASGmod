/**
 * Why the engine's own corner stops at 2.31 cells.
 *
 * Every honest ledger now clears the engine on approaching (§48–52). What has
 * not moved since the first measurement is what it builds for itself: a corner
 * nobody contested yields the player 7.25 cells and the engine 2.31, and its
 * territory on the rest of the board is six cells to the player's eleven.
 *
 * So this looks at the corners each side opened. How many stones went in, when
 * the last one landed, how long the side went without touching it, and what it
 * was worth at the end — plus the finished shape of the uncontested ones printed
 * out, because thirteen boards can simply be read.
 *
 *   npx vite-node own-corner.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const SHOW = process.env.SHOW !== "0";

const cornerOf = (row: number, col: number) =>
  row === 4 || col === 4 ? null : `${row < 4 ? "T" : "B"}${col < 4 ? "L" : "R"}`;

interface Corner {
  side: string;
  contested: boolean;
  stones: number;
  firstTurn: number;
  lastTurn: number;
  /** Longest run of the opener's own turns with nothing played in this corner. */
  idle: number;
  kept: number;
  board?: string[];
}

const all: Corner[] = [];
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const nameOf = (p: Player) => (p === human ? "human" : "ai");

    interface Track {
      by: Player;
      contested: boolean;
      stones: number;
      firstTurn: number;
      lastTurn: number;
      idle: number;
      since: number;
    }
    const corners = new Map<string, Track>();
    const ownTurns: Record<string, number> = { A: 0, B: 0 };

    let state: GameState = createInitialState();
    let turn = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      turn += 1;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (m.type !== "PLACE") continue;
      ownTurns[mover] += 1;

      const corner = cornerOf(m.row, m.col);
      if (!corner) continue;
      const held = corners.get(corner);
      if (held === undefined) {
        corners.set(corner, {
          by: mover,
          contested: false,
          stones: 1,
          firstTurn: turn,
          lastTurn: turn,
          idle: 0,
          since: ownTurns[mover],
        });
        continue;
      }
      if (mover !== held.by) {
        held.contested = true;
        continue;
      }
      held.stones += 1;
      held.lastTurn = turn;
      held.idle = Math.max(held.idle, ownTurns[mover] - held.since - 1);
      held.since = ownTurns[mover];
    }

    // The stretch from the last stone in the corner to the end of the game counts
    // too — a corner abandoned at turn 9 of a 60-turn game was abandoned.
    for (const [corner, held] of corners) {
      held.idle = Math.max(held.idle, ownTurns[held.by] - held.since);
      const kept = state.territories[held.by].filter(
        (c: { row: number; col: number }) => cornerOf(c.row, c.col) === corner,
      ).length;

      let picture: string[] | undefined;
      if (SHOW && !held.contested) {
        const rows = held.by === "A" || true ? [0, 1, 2, 3, 4] : [];
        const flipR = corner[0] === "B";
        const flipC = corner[1] === "R";
        const settled = new Set(
          state.territories[held.by].map((c: { row: number; col: number }) => `${c.row},${c.col}`),
        );
        picture = rows.map((r) =>
          [0, 1, 2, 3, 4]
            .map((c) => {
              const row = flipR ? 8 - r : r;
              const col = flipC ? 8 - c : c;
              const cell = state.board[row][col];
              if (cell === "PLAYER_A") return held.by === "A" ? "O" : "x";
              if (cell === "PLAYER_B") return held.by === "B" ? "O" : "x";
              return settled.has(`${row},${col}`) ? "," : ".";
            })
            .join(" "),
        );
      }

      all.push({
        side: nameOf(held.by),
        contested: held.contested,
        stones: held.stones,
        firstTurn: held.firstTurn,
        lastTurn: held.lastTurn,
        idle: held.idle,
        kept,
        board: picture,
      });
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const ci = (xs: number[]) => {
  if (xs.length < 2) return "-";
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  return `${m.toFixed(2)} +/- ${((1.96 * sd) / Math.sqrt(xs.length)).toFixed(2)}`;
};

console.log(`corners each side opened, ${all.length} of them\n`);
console.log(
  `${"side".padEnd(8)}${"corner".padStart(12)}${"n".padStart(5)}${"stones".padStart(9)}` +
    `${"opened".padStart(9)}${"last stone".padStart(12)}${"idle turns".padStart(12)}` +
    `${"kept".padStart(16)}`,
);
for (const side of ["human", "ai"]) {
  for (const [label, want] of [["uncontested", false], ["contested", true]] as Array<[string, boolean]>) {
    const g = all.filter((c) => c.side === side && c.contested === want);
    if (g.length === 0) continue;
    console.log(
      `${side.padEnd(8)}${label.padStart(12)}${String(g.length).padStart(5)}` +
        `${mean(g.map((c) => c.stones)).toFixed(2).padStart(9)}` +
        `${mean(g.map((c) => c.firstTurn)).toFixed(1).padStart(9)}` +
        `${mean(g.map((c) => c.lastTurn)).toFixed(1).padStart(12)}` +
        `${mean(g.map((c) => c.idle)).toFixed(1).padStart(12)}` +
        `${ci(g.map((c) => c.kept)).padStart(16)}`,
    );
  }
}

console.log(`\nkept, by how many stones went in (uncontested corners only)\n`);
console.log(`${"side".padEnd(8)}${"stones".padStart(9)}${"n".padStart(5)}${"kept".padStart(16)}`);
for (const side of ["human", "ai"]) {
  const g = all.filter((c) => c.side === side && !c.contested);
  for (const [label, pick] of [
    ["1-2", (c: Corner) => c.stones <= 2],
    ["3-4", (c: Corner) => c.stones >= 3 && c.stones <= 4],
    ["5+", (c: Corner) => c.stones >= 5],
  ] as Array<[string, (c: Corner) => boolean]>) {
    const x = g.filter(pick);
    if (x.length === 0) continue;
    console.log(
      `${side.padEnd(8)}${label.padStart(9)}${String(x.length).padStart(5)}` +
        `${ci(x.map((c) => c.kept)).padStart(16)}`,
    );
  }
}

if (SHOW) {
  console.log(`\nthe uncontested corners as they finished — O own stone, x theirs, , settled\n`);
  for (const side of ["human", "ai"]) {
    for (const c of all.filter((x) => x.side === side && !x.contested && x.board)) {
      console.log(`  ${side}, ${c.stones} stones, turns ${c.firstTurn}-${c.lastTurn}, kept ${c.kept}`);
      for (const line of c.board!) console.log(`      ${line}`);
      console.log();
    }
  }
}
