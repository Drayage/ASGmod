/**
 * What the nth stone in a corner is worth.
 *
 * The book spends two stones on a corner and leaves, on the promise that a
 * later turn comes back and closes it for 6.23 cells. In the two games decided
 * on count on build eef3461 the engine instead ended with eleven and twelve
 * stones in one quadrant for three to five cells, at 0.40 cells per stone
 * against the player's 0.80 — and every one of those late stones was chosen by
 * the full search, not by the book.
 *
 * So this asks the corpus directly: group every (game, side, quadrant) by how
 * many stones that side ended with there, and report the cells held. If the
 * curve flattens, stones past the knee are being thrown away, and the search
 * that chooses them has no term that knows it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const DIR = "/root/.claude/uploads/3324222b-a3a1-5d65-b076-49f89abeeae5";
const quad = (r: number, c: number) => `${r <= 4 ? "위" : "아래"}${c <= 4 ? "왼" : "오"}`;
const QUADS = ["위왼", "위오", "아래왼", "아래오"];

type Row = { stones: number; cells: number };
const eng: Row[] = [];
const hum: Row[] = [];
let games = 0;

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  let recs: any[];
  try { recs = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")).records ?? []; } catch { continue; }
  for (const rec of recs) {
    if (rec.mode !== "AI" || !rec.moveHistory || !rec.playerSide) continue;
    // Only counted games: a capture ends the board early and the quadrants
    // never finish, which would read as "many stones, no cells" for both sides.
    if (rec.winReason !== "TERRITORY") continue;
    games += 1;
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    let s = createInitialState();
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
    for (const p of ["A", "B"] as Player[]) for (const cell of t[p]) cells[quad(cell.row, cell.col)][p] += 1;
    for (const q of QUADS) {
      eng.push({ stones: stones[q][engine], cells: cells[q][engine] });
      hum.push({ stones: stones[q][human], cells: cells[q][human] });
    }
  }
}

/** Cells held, bucketed by stones spent in that quadrant. */
function curve(rows: Row[], label: string) {
  console.log(`\n${label}`);
  console.log(`${"그 귀에 둔 돌".padStart(12)}${"표본".padStart(7)}${"평균 집".padStart(9)}${"돌당".padStart(8)}${"직전 대비 +집".padStart(15)}`);
  const buckets = new Map<number, number[]>();
  for (const r of rows) {
    const key = Math.min(r.stones, 12);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r.cells);
  }
  let prevMean: number | null = null;
  for (const n of [...buckets.keys()].sort((a, b) => a - b)) {
    const vs = buckets.get(n)!;
    const mean = vs.reduce((s, v) => s + v, 0) / vs.length;
    const marginal = prevMean === null ? "" : (mean - prevMean).toFixed(2);
    console.log(
      `${String(n).padStart(12)}${String(vs.length).padStart(7)}${mean.toFixed(2).padStart(9)}` +
      `${(n === 0 ? "-" : (mean / n).toFixed(2)).padStart(8)}${marginal.padStart(15)}`,
    );
    prevMean = mean;
  }
}

console.log(`집으로 끝난 판 ${games}개, 귀 표본 ${eng.length}개씩`);
curve(eng, "엔진");
curve(hum, "사람");
