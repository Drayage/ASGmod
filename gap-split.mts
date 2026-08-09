/**
 * Where the territory gap actually is, split by region size.
 *
 * The figure this branch has worked from — 5.9 of an 8.4-cell gap coming from
 * regions of four cells or more — was measured on a smaller corpus and older
 * builds. Two things since then turned out to be build-dependent, so this
 * recomputes it over every recorded game and splits by build, and reports the
 * distinct-region counts alongside the cells so a gap made of many small
 * regions cannot be mistaken for one made of a few large ones.
 *
 *   npx vite-node gap-split.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { DIRECTIONS, inBounds, opponent } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

/** Only games the count decided: a capture ends the game wherever it stands,
 * and its final board says nothing about who was winning the territory. */
const ONLY_COUNTED = process.env.ALL !== "1";
const BUCKETS = [1, 2, 3, 4, 6] as const;

function regions(cells: Coord[]): Coord[][] {
  const set = new Set(cells.map((c) => `${c.row},${c.col}`));
  const seen = new Set<string>();
  const out: Coord[][] = [];
  for (const c of cells) {
    if (seen.has(`${c.row},${c.col}`)) continue;
    seen.add(`${c.row},${c.col}`);
    const group: Coord[] = [];
    const stack = [c];
    while (stack.length) {
      const cur = stack.pop()!;
      group.push(cur);
      for (const [dr, dc] of DIRECTIONS) {
        const r = cur.row + dr, cc = cur.col + dc;
        const k = `${r},${cc}`;
        if (inBounds(r, cc) && set.has(k) && !seen.has(k)) { seen.add(k); stack.push({ row: r, col: cc }); }
      }
    }
    out.push(group);
  }
  return out;
}

const bucketOf = (size: number) => {
  for (let i = BUCKETS.length - 1; i >= 0; i -= 1) if (size >= BUCKETS[i]) return i;
  return 0;
};
const label = (i: number) =>
  i === BUCKETS.length - 1 ? `${BUCKETS[i]}+` : BUCKETS[i] === BUCKETS[i + 1] - 1 ? `${BUCKETS[i]}` : `${BUCKETS[i]}-${BUCKETS[i + 1] - 1}`;

interface Tally { cells: number[]; count: number[] }
const blank = (): Tally => ({ cells: new Array(BUCKETS.length).fill(0), count: new Array(BUCKETS.length).fill(0) });
const byBuild = new Map<string, { games: number; human: Tally; ai: Tally }>();

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY_COUNTED && rec.winReason !== "TERRITORY") continue;
    const human: Player = rec.playerSide;
    const ai = opponent(human);

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
    const finalT = calculateTerritories(state.board);

    const build = (rec.appVersion ?? "older").slice(0, 7);
    for (const key of [build, "ALL"]) {
      const entry = byBuild.get(key) ?? { games: 0, human: blank(), ai: blank() };
      byBuild.set(key, entry);
      entry.games += 1;
      for (const [tally, side] of [[entry.human, human], [entry.ai, ai]] as const) {
        for (const region of regions(finalT[side])) {
          const b = bucketOf(region.length);
          tally.cells[b] += region.length;
          tally.count[b] += 1;
        }
      }
    }
  }
}

console.log(`final territory by region size, ${ONLY_COUNTED ? "games decided by the count only" : "every game"}\n`);
for (const [build, e] of [...byBuild.entries()].sort((a, b) => (a[0] === "ALL" ? 1 : b[0] === "ALL" ? -1 : 0))) {
  const per = (x: number) => x / e.games;
  console.log(`${build}  (${e.games} game${e.games === 1 ? "" : "s"})`);
  console.log(
    `  ${"region size".padEnd(14)}` +
      BUCKETS.map((_, i) => label(i).padStart(9)).join("") +
      `${"total".padStart(9)}`,
  );
  const row = (name: string, t: Tally) =>
    console.log(
      `  ${name.padEnd(14)}` +
        t.cells.map((c) => per(c).toFixed(1).padStart(9)).join("") +
        `${per(t.cells.reduce((a, b) => a + b, 0)).toFixed(1).padStart(9)}`,
    );
  row("human cells", e.human);
  row("AI cells", e.ai);
  console.log(
    `  ${"gap".padEnd(14)}` +
      e.human.cells.map((c, i) => (per(c) - per(e.ai.cells[i])).toFixed(1).padStart(9)).join("") +
      `${(per(e.human.cells.reduce((a, b) => a + b, 0)) - per(e.ai.cells.reduce((a, b) => a + b, 0))).toFixed(1).padStart(9)}`,
  );
  console.log(
    `  ${"regions, human".padEnd(14)}` + e.human.count.map((c) => per(c).toFixed(2).padStart(9)).join(""),
  );
  console.log(
    `  ${"regions, AI".padEnd(14)}` + e.ai.count.map((c) => per(c).toFixed(2).padStart(9)).join(""),
  );
  console.log();
}
