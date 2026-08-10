/**
 * Does the frame line describe the human's play, and do they size to the
 * opposition?
 *
 * The player's doctrine: treat the corner frame as the first joseki, do not rush
 * to finish it when nobody contests, and choose how much to take by how strongly
 * the opponent is coming — small and obstructive where they are strong, big where
 * they are absent.
 *
 * The frame points are the corner's anti-diagonal, the cells whose two edge
 * distances sum to three. So the first question is whether that line describes
 * where the human's early stones actually land. The second is whether the size
 * of what each side ends up holding in a corner tracks the enemy stones that
 * were there when they committed to it.
 *
 *   npx vite-node frame-line.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const FIRST = Number(process.env.FIRST ?? 8);
const quadrant = (row: number, col: number) =>
  row === 4 || col === 4 ? null : `${row < 4 ? "T" : "B"}${col < 4 ? "L" : "R"}`;
const edgeSum = (row: number, col: number) =>
  Math.min(row, 8 - row) + Math.min(col, 8 - col);

const onLine: Record<string, { n: number; hits: number }> = {
  human: { n: 0, hits: 0 },
  ai: { n: 0, hits: 0 },
};
/** Cells finally held in a corner, against enemy stones there at commit time. */
const sizing: Record<string, Array<{ enemies: number; cells: number }>> = { human: [], ai: [] };

const seen = new Set<string>();
let games = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    games += 1;
    const human: Player = rec.playerSide;

    const states: GameState[] = [createInitialState()];
    for (const m of rec.moveHistory) {
      const cur = states[states.length - 1];
      if (cur.winner) break;
      states.push(
        m.type === "PASS"
          ? applyAction(cur, { type: "PASS" })
          : applyAction(cur, { type: "PLACE", row: m.row!, col: m.col! }),
      );
    }
    const finalT = calculateTerritories(states[states.length - 1].board);

    const count: Record<string, number> = { human: 0, ai: 0 };
    // The turn each side put its second stone into a given corner.
    const committed: Record<string, Map<string, number>> = { human: new Map(), ai: new Map() };
    const inCorner: Record<string, Map<string, number>> = { human: new Map(), ai: new Map() };

    for (let i = 0; i < states.length - 1; i += 1) {
      const m = rec.moveHistory[i];
      if (!m || m.type !== "PLACE") continue;
      const before = states[i];
      const mover = before.currentPlayer;
      const name = mover === human ? "human" : "ai";

      if (count[name] < FIRST) {
        count[name] += 1;
        onLine[name].n += 1;
        if (quadrant(m.row, m.col) && edgeSum(m.row, m.col) === 3) onLine[name].hits += 1;
      }

      const q = quadrant(m.row, m.col);
      if (!q) continue;
      const have = (inCorner[name].get(q) ?? 0) + 1;
      inCorner[name].set(q, have);
      if (have === 2 && !committed[name].has(q)) {
        let enemies = 0;
        for (let row = 0; row < 9; row += 1) {
          for (let col = 0; col < 9; col += 1) {
            if (quadrant(row, col) !== q) continue;
            if (before.board[row][col] === playerCell(opponent(mover))) enemies += 1;
          }
        }
        committed[name].set(q, enemies);
      }
    }

    for (const name of ["human", "ai"]) {
      const side: Player = name === "human" ? human : opponent(human);
      for (const [q, enemies] of committed[name]) {
        let cells = 0;
        for (const c of finalT[side] as Coord[]) if (quadrant(c.row, c.col) === q) cells += 1;
        sizing[name].push({ enemies, cells });
      }
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(`the first ${FIRST} stones of each side, ${games} games\n`);
for (const name of ["human", "ai"]) {
  const o = onLine[name];
  console.log(`  ${name.padEnd(8)}on a corner frame line: ${o.hits}/${o.n} (${pct(o.hits, o.n)})`);
}
console.log(`\ncells finally held in a corner, against enemy stones there when the second stone landed`);
console.log(`${"side".padEnd(8)}${"enemies".padStart(9)}${"corners".padStart(9)}${"cells held".padStart(12)}`);
for (const name of ["human", "ai"]) {
  for (const band of [0, 1, 2]) {
    const rows = sizing[name].filter((r) =>
      band === 2 ? r.enemies >= 2 : r.enemies === band,
    );
    if (rows.length < 3) continue;
    console.log(
      `${name.padEnd(8)}${(band === 2 ? "2+" : String(band)).padStart(9)}` +
        `${String(rows.length).padStart(9)}${mean(rows.map((r) => r.cells)).toFixed(2).padStart(12)}`,
    );
  }
}
