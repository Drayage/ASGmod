/**
 * Where the remaining gap actually is.
 *
 * Declined seals turn out to cost 2.2 cells a game against a deficit of 8.6, so
 * the engine is not losing by failing to close. The other possibility is that
 * it never has much to close: the same number of regions but smaller, or fewer
 * regions entirely.
 *
 * This counts the final confirmed territory of each side as connected regions
 * and reports their sizes, which separates "many small" from "a few large".
 *
 *   npx vite-node region-size.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { DIRECTIONS, inBounds, opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

/** Connected components of a set of points. */
function regions(cells: Array<{ row: number; col: number }>): number[] {
  const set = new Set(cells.map((c) => `${c.row},${c.col}`));
  const seen = new Set<string>();
  const sizes: number[] = [];
  for (const c of cells) {
    const start = `${c.row},${c.col}`;
    if (seen.has(start)) continue;
    let size = 0;
    const stack = [c];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop()!;
      size += 1;
      for (const [dr, dc] of DIRECTIONS) {
        const r = cur.row + dr, cc = cur.col + dc;
        const k = `${r},${cc}`;
        if (inBounds(r, cc) && set.has(k) && !seen.has(k)) { seen.add(k); stack.push({ row: r, col: cc }); }
      }
    }
    sizes.push(size);
  }
  return sizes;
}

const stats = new Map<string, { ai: number[]; human: number[]; games: number }>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.winReason !== "TERRITORY") continue; // only games that reached a count
    const build = rec.appVersion ?? "?";
    const s = stats.get(build) ?? { ai: [], human: [], games: 0 };
    stats.set(build, s);
    s.games += 1;
    const human: Player = rec.playerSide;
    const ai = opponent(human);
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row, col: m.col });
    }
    const t = calculateTerritories(state.board);
    s.ai.push(...regions(t[ai]));
    s.human.push(...regions(t[human]));
  }
}

for (const [build, s] of [...stats.entries()].sort((a, b) => a[1].games - b[1].games)) {
  console.log(`\n=== ${build}  (${s.games} counted games)`);
  for (const [who, sizes] of [["AI", s.ai], ["human", s.human]] as const) {
    const total = sizes.reduce((a, b) => a + b, 0);
    const big = sizes.filter((v) => v >= 4);
    console.log(
      `  ${who.padEnd(6)} ${String(sizes.length).padStart(3)} regions, ${String(total).padStart(3)} cells` +
        `   mean ${(total / sizes.length).toFixed(1)}   largest ${Math.max(...sizes)}` +
        `   regions of 4+: ${big.length} (${big.reduce((a, b) => a + b, 0)} cells)`,
    );
    const hist = new Map<number, number>();
    for (const v of sizes) hist.set(v, (hist.get(v) ?? 0) + 1);
    console.log(`         sizes: ${[...hist.keys()].sort((a, b) => a - b).map((k) => `${k}x${hist.get(k)}`).join("  ")}`);
  }
}
