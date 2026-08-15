/**
 * "왜 자기 귀에다가 자꾸 두는거야 크게먹는것도아닌데 초반에 그걸로 템포 다뺏기던데"
 *
 * `invasion-phase.mts` cleared the book of hijacking the middlegame — it stops
 * at ply 10.6 as designed. That is not the same as the book being worth its
 * turns, which nothing here has ever checked directly. The book spends the
 * opening on its own corners; the player spends the same plies elsewhere. This
 * counts what each side had to show for those plies by the end.
 *
 * For every game: which cells did each side finally hold, split by whether they
 * sit in a corner the engine's book stones opened, and how many stones did each
 * side spend there.
 *
 *   npx vite-node book-tempo.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const COLS = "ABCDEFGHI";
const nm = (r: number, c: number) => `${COLS[c]}${r + 1}`;
const THINK = Number(process.env.THINK ?? 1500);

/** Which quadrant a cell belongs to, or null for the middle lines. */
function quadrantOf(row: number, col: number, size: number): string | null {
  const half = Math.floor(size / 2);
  if (row === half || col === half) return null;
  return `${row < half ? "T" : "B"}${col < half ? "L" : "R"}`;
}

interface Row {
  bookMoves: number;
  bookCorners: Set<string>;
  engineInBook: number;
  engineElsewhere: number;
  humanInBook: number;
  humanElsewhere: number;
  humanStonesInBook: number;
  humanMovesDuringBook: number;
  humanCellsFromThose: number;
}
const rows: Row[] = [];
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    applyAIVariant((rec.aiVariant ?? "EYE") as AIVariant);

    // Replay once to learn which turns the book decided, and where it played.
    const bookCorners = new Set<string>();
    let bookMoves = 0;
    let bookEndPly = 0;
    const humanEarly: Array<{ row: number; col: number }> = [];
    let state: GameState = createInitialState();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      ply += 1;
      if (state.currentPlayer === engine && m.type === "PLACE") {
        findBestMoveVeryHard(state, engine, THINK);
        if (lastDecision.stage.startsWith("1.88") || lastDecision.stage.startsWith("0 opening")) {
          bookMoves += 1;
          bookEndPly = ply;
          const q = quadrantOf(m.row!, m.col!, state.board.length);
          if (q) bookCorners.add(q);
        }
      }
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }

    // The human's own moves over the same stretch.
    let s2: GameState = createInitialState();
    let p2 = 0;
    for (const m of rec.moveHistory) {
      if (s2.winner) break;
      p2 += 1;
      if (p2 > bookEndPly) break;
      if (s2.currentPlayer === human && m.type === "PLACE") humanEarly.push({ row: m.row!, col: m.col! });
      s2 = m.type === "PASS"
        ? applyAction(s2, { type: "PASS" })
        : applyAction(s2, { type: "PLACE", row: m.row!, col: m.col! });
    }

    let final: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (final.winner) break;
      final = m.type === "PASS"
        ? applyAction(final, { type: "PASS" })
        : applyAction(final, { type: "PLACE", row: m.row!, col: m.col! });
    }
    const size = final.board.length;
    const terr = calculateTerritories(final.board);

    const split = (side: Player) => {
      let inBook = 0;
      let elsewhere = 0;
      for (const c of terr[side]) {
        const q = quadrantOf(c.row, c.col, size);
        if (q && bookCorners.has(q)) inBook += 1;
        else elsewhere += 1;
      }
      return { inBook, elsewhere };
    };
    const e = split(engine);
    const h = split(human);

    // Human stones that ended up inside the corners the book claimed.
    let humanStonesInBook = 0;
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (final.board[r][c] !== playerCell(human)) continue;
        const q = quadrantOf(r, c, size);
        if (q && bookCorners.has(q)) humanStonesInBook += 1;
      }
    }

    rows.push({
      bookMoves,
      bookCorners,
      engineInBook: e.inBook,
      engineElsewhere: e.elsewhere,
      humanInBook: h.inBook,
      humanElsewhere: h.elsewhere,
      humanStonesInBook,
      humanMovesDuringBook: humanEarly.length,
      humanCellsFromThose: 0,
    });
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`games: ${rows.length}\n`);
console.log(`book moves per game: ${mean(rows.map((r) => r.bookMoves)).toFixed(1)}`);
console.log(`corners it opened: ${mean(rows.map((r) => r.bookCorners.size)).toFixed(1)}`);
console.log(`the player's own moves over the same plies: ${mean(rows.map((r) => r.humanMovesDuringBook)).toFixed(1)}\n`);
console.log(`final cells, split by whether the corner is one the book opened\n`);
console.log(`${"".padEnd(10)}${"in those corners".padStart(18)}${"everywhere else".padStart(18)}`);
console.log(
  `${"engine".padEnd(10)}${mean(rows.map((r) => r.engineInBook)).toFixed(1).padStart(18)}` +
    `${mean(rows.map((r) => r.engineElsewhere)).toFixed(1).padStart(18)}`,
);
console.log(
  `${"player".padEnd(10)}${mean(rows.map((r) => r.humanInBook)).toFixed(1).padStart(18)}` +
    `${mean(rows.map((r) => r.humanElsewhere)).toFixed(1).padStart(18)}`,
);
console.log(
  `\nplayer stones sitting inside those same corners at the end: ` +
    `${mean(rows.map((r) => r.humanStonesInBook)).toFixed(1)}`,
);
console.log(
  `cells per book move: ${(mean(rows.map((r) => r.engineInBook)) / Math.max(1, mean(rows.map((r) => r.bookMoves)))).toFixed(2)}`,
);
