/**
 * What a corner actually returned, per quadrant, per side.
 *
 * The book puts two stones in a corner and moves on, on the strength of an
 * arena result (61.3% of 240) and a note that a two-stone corner "finishes
 * worth 6.23 cells". The second half is a promise about a later turn, and the
 * engine keeps it 0.7% of the time against a 15.7% opportunity. So this counts
 * the thing itself: stones spent in each quadrant against cells held there at
 * the end, for both players, on games decided by count.
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

/** Quadrant by which half of each axis a cell sits in; the middle lines are
 * shared rather than dropped, so every stone is counted somewhere. */
const quad = (r: number, c: number) => `${r <= 4 ? "위" : "아래"}${c <= 4 ? "왼" : "오"}`;
const QUADS = ["위왼", "위오", "아래왼", "아래오"];

let engStones = 0, engCells = 0, humStones = 0, humCells = 0;

for (const path of process.argv.slice(2)) {
  const recs = JSON.parse(readFileSync(path, "utf8")).records ?? [];
  recs.forEach((rec: any, gi: number) => {
    const human: Player = rec.playerSide;
    const eng = opponent(human);
    let s: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      s = applyAction(s, m.type === "PASS" ? { type: "PASS" } : { type: "PLACE", row: m.row, col: m.col });
    }
    const t = calculateTerritories(s.board);
    const stones: Record<string, Record<Player, number>> = {};
    const cells: Record<string, Record<Player, number>> = {};
    for (const q of QUADS) { stones[q] = { A: 0, B: 0 }; cells[q] = { A: 0, B: 0 }; }
    for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) {
      if (s.board[r][c] === playerCell("A")) stones[quad(r, c)].A += 1;
      else if (s.board[r][c] === playerCell("B")) stones[quad(r, c)].B += 1;
    }
    for (const p of ["A", "B"] as Player[]) {
      for (const cell of t[p]) cells[quad(cell.row, cell.col)][p] += 1;
    }
    console.log(`\n=== ${gi + 1}판  사람 ${human} / 엔진 ${eng}  A ${rec.territoryA} : B ${rec.territoryB}`);
    console.log(`${"귀".padEnd(8)}${"엔진 돌".padStart(8)}${"엔진 집".padStart(8)}${"돌당".padStart(7)}${"사람 돌".padStart(9)}${"사람 집".padStart(8)}${"돌당".padStart(7)}`);
    for (const q of QUADS) {
      const es = stones[q][eng], ec = cells[q][eng], hs = stones[q][human], hc = cells[q][human];
      engStones += es; engCells += ec; humStones += hs; humCells += hc;
      const per = (c: number, n: number) => (n === 0 ? "-" : (c / n).toFixed(2));
      console.log(
        `${q.padEnd(8)}${String(es).padStart(8)}${String(ec).padStart(8)}${per(ec, es).padStart(7)}` +
        `${String(hs).padStart(9)}${String(hc).padStart(8)}${per(hc, hs).padStart(7)}`,
      );
    }
  });
}
console.log(
  `\n합계  엔진 돌 ${engStones} → ${engCells}집 (돌당 ${(engCells / engStones).toFixed(2)})` +
  `   사람 돌 ${humStones} → ${humCells}집 (돌당 ${(humCells / humStones).toFixed(2)})`,
);
