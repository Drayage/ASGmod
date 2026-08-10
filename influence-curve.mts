/**
 * Calibrating the influence term against what influence actually becomes.
 *
 * `projectedMarginFrom` scores open ground as `influence * 0.12`, one flat rate
 * for every cell. That rate was tuned as a scalar and came out optimal as one —
 * but a scalar cannot express what the games say, which is that conversion
 * depends steeply on the size of the region a cell sits in: a room of six cells
 * or fewer becomes its owner's territory in full, a room of nineteen or more at
 * a quarter, and the curve is the same for both players.
 *
 * If that holds on the engine's own definition of influence rather than on the
 * room definition it was measured with, then 0.12 is not one number in the wrong
 * place — it is one number where a curve belongs, and it overvalues exactly the
 * sprawling middle-game frame the engine keeps holding.
 *
 * So this counts, over every position in the recorded games, what fraction of
 * influenced cells became their claimant's territory, split by the size of the
 * connected influence region the cell belonged to.
 *
 *   AT=31 npx vite-node influence-curve.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { influenceOwnerMap } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const AT = Number(process.env.AT ?? 31);
const BANDS = [1, 3, 5, 8, 12, 18] as const;
const bandOf = (n: number) => {
  for (let i = BANDS.length - 1; i >= 0; i -= 1) if (n >= BANDS[i]) return i;
  return 0;
};
const label = (i: number) =>
  i === BANDS.length - 1
    ? `${BANDS[i]}+`
    : BANDS[i] === BANDS[i + 1] - 1
      ? `${BANDS[i]}`
      : `${BANDS[i]}-${BANDS[i + 1] - 1}`;

const claimed = new Array(BANDS.length).fill(0);
const converted = new Array(BANDS.length).fill(0);
let games = 0;

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;

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
    if (states.length <= AT) continue;
    games += 1;
    const at = states[AT];
    const finalT = calculateTerritories(states[states.length - 1].board);
    const owns: Record<Player, Set<string>> = {
      A: new Set(finalT.A.map((c: Coord) => `${c.row},${c.col}`)),
      B: new Set(finalT.B.map((c: Coord) => `${c.row},${c.col}`)),
    };

    // The engine's own influence map, grouped into connected same-claimant
    // regions so each cell can be scored by the size of the region it is in.
    const owners = influenceOwnerMap(at.board);
    const ownerAt = (row: number, col: number) => owners[row * BOARD_SIZE + col];
    const visited = new Set<string>();
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        const side = ownerAt(row, col);
        if (!side || visited.has(`${row},${col}`)) continue;
        const cells: Coord[] = [];
        const stack: Coord[] = [{ row, col }];
        visited.add(`${row},${col}`);
        while (stack.length) {
          const cur = stack.pop()!;
          cells.push(cur);
          for (const [dr, dc] of DIRECTIONS) {
            const r = cur.row + dr, c = cur.col + dc;
            if (!inBounds(r, c) || visited.has(`${r},${c}`)) continue;
            if (ownerAt(r, c) !== side) continue;
            visited.add(`${r},${c}`);
            stack.push({ row: r, col: c });
          }
        }
        const b = bandOf(cells.length);
        for (const cell of cells) {
          claimed[b] += 1;
          if (owns[side].has(`${cell.row},${cell.col}`)) converted[b] += 1;
        }
      }
    }
  }
}

const pct = (n: number, d: number) => (d ? (n / d) : NaN);
console.log(
  `what an influenced cell at turn ${AT} became, by the size of its influence region\n` +
    `${games} games decided by the count, both sides pooled\n`,
);
console.log(`${"region size".padEnd(14)}${BANDS.map((_, i) => label(i).padStart(10)).join("")}`);
console.log(`${"cells".padEnd(14)}${claimed.map((c) => String(c).padStart(10)).join("")}`);
console.log(
  `${"converted".padEnd(14)}${converted
    .map((c, i) => `${(pct(c, claimed[i]) * 100).toFixed(0)}%`.padStart(10))
    .join("")}`,
);
console.log(
  `\nthe rate the evaluation uses for every one of them: 0.12\n` +
    `calibrated rate  ${BANDS.map((_, i) => pct(converted[i], claimed[i]).toFixed(2).padStart(10)).join("")}`,
);
