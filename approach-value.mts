/**
 * What an approach is actually for.
 *
 * approach-shape measured an approach by what the approacher ended up owning in
 * that corner, and by that measure the engine looked bad at approaching. But
 * that is the wrong ledger. An approach is spent to take cells away from the
 * other side cheaply; the stones it does not spend are supposed to show up as
 * territory somewhere else. A approach that keeps nothing and denies six is a
 * good one.
 *
 * So this counts three things per approach: how many stones the approacher put
 * into that quadrant, what the opener ended up holding there, and what the
 * approacher held everywhere else. Grouping by the stones spent turns the first
 * two into a price and the third into what the price bought.
 *
 *   npx vite-node approach-value.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const cornerOf = (row: number, col: number) =>
  row === 4 || col === 4 ? null : `${row < 4 ? "T" : "B"}${col < 4 ? "L" : "R"}`;

interface Approach {
  side: string;
  /** Stones the approacher put in that quadrant, the first one included. */
  spent: number;
  /** What the side that opened the corner ended up holding in it. */
  denied: number;
  /** What the approacher held in it. */
  kept: number;
  /** What the approacher held on the rest of the board. */
  elsewhere: number;
  diagonal: number;
  straight: number;
}

/** What a corner yielded its opener when nobody came in — the price of not approaching. */
const untouched: Record<string, number[]> = { human: [], ai: [] };
const all: Approach[] = [];
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const nameOf = (p: Player) => (p === human ? "human" : "ai");

    const opener = new Map<string, Player>();
    const entered = new Map<string, { by: Player; spent: number; diagonal: number; straight: number }>();

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const before = state;
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
      const already = entered.get(corner);
      if (already === undefined) {
        entered.set(corner, { by: mover, spent: 1, diagonal: 0, straight: 0 });
        continue;
      }
      if (already.by !== mover) continue;
      already.spent += 1;
      // Which way this stone joined what they already had there. approach-shape
      // found this separated the productive approaches; whether it survives on
      // the denial ledger is the question.
      const mine = before.board;
      const cell = mover === "A" ? "PLAYER_A" : "PLAYER_B";
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const r = m.row! + dr;
        const c = m.col! + dc;
        if (r < 0 || r > 8 || c < 0 || c > 8) continue;
        if (mine[r][c] === cell && cornerOf(r, c) === corner) { already.straight += 1; break; }
      }
      for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const r = m.row! + dr;
        const c = m.col! + dc;
        if (r < 0 || r > 8 || c < 0 || c > 8) continue;
        if (mine[r][c] === cell && cornerOf(r, c) === corner) { already.diagonal += 1; break; }
      }
    }

    const inCorner = (side: Player, corner: string) =>
      state.territories[side].filter(
        (c: { row: number; col: number }) => cornerOf(c.row, c.col) === corner,
      ).length;

    for (const [corner, by] of opener) {
      const came = entered.get(corner);
      if (came === undefined) {
        untouched[nameOf(by)].push(inCorner(by, corner));
        continue;
      }
      all.push({
        side: nameOf(came.by),
        spent: came.spent,
        denied: inCorner(by, corner),
        kept: inCorner(came.by, corner),
        elsewhere:
          state.territories[came.by].length - inCorner(came.by, corner),
        diagonal: came.diagonal,
        straight: came.straight,
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

console.log(`what a corner yielded its opener when nobody came in\n`);
for (const side of ["human", "ai"]) {
  console.log(`  ${side.padEnd(8)}${ci(untouched[side]).padStart(16)}  (n=${untouched[side].length})`);
}

console.log(`\nand when the other side came in, by how many stones they spent\n`);
console.log(
  `${"side".padEnd(8)}${"stones".padStart(8)}${"n".padStart(5)}` +
    `${"opener kept".padStart(18)}${"approacher kept".padStart(18)}` +
    `${"approacher elsewhere".padStart(22)}`,
);
for (const side of ["human", "ai"]) {
  const xs = all.filter((a) => a.side === side);
  for (const [label, pick] of [
    ["1-2", (a: Approach) => a.spent <= 2],
    ["3-4", (a: Approach) => a.spent >= 3 && a.spent <= 4],
    ["5+", (a: Approach) => a.spent >= 5],
  ] as Array<[string, (a: Approach) => boolean]>) {
    const g = xs.filter(pick);
    if (g.length === 0) continue;
    console.log(
      `${side.padEnd(8)}${label.padStart(8)}${String(g.length).padStart(5)}` +
        `${ci(g.map((a) => a.denied)).padStart(18)}${ci(g.map((a) => a.kept)).padStart(18)}` +
        `${ci(g.map((a) => a.elsewhere)).padStart(22)}`,
    );
  }
}

console.log(`\nthe same as a price: cells taken off the opener per stone spent\n`);
console.log(
  `${"side".padEnd(8)}${"approaches".padStart(12)}${"stones each".padStart(13)}` +
    `${"denied vs untouched".padStart(21)}${"per stone".padStart(11)}`,
);
for (const side of ["human", "ai"]) {
  const xs = all.filter((a) => a.side === side);
  // The other side's corners, so the baseline is what that side's corners
  // yielded when they were left alone.
  const other = side === "human" ? "ai" : "human";
  const base = mean(untouched[other]);
  const spent = mean(xs.map((a) => a.spent));
  const cut = base - mean(xs.map((a) => a.denied));
  console.log(
    `${side.padEnd(8)}${String(xs.length).padStart(12)}${spent.toFixed(2).padStart(13)}` +
      `${cut.toFixed(2).padStart(21)}${(cut / spent).toFixed(2).padStart(11)}`,
  );
}

// approach-shape read this split on what the approacher kept, which is the wrong
// ledger for a move whose job is to take cells off the other side. Same split,
// denial as the measure.
console.log(`\nthe diagonal split again, measured as denial\n`);
console.log(
  `${"side".padEnd(8)}${"connections".padStart(18)}${"n".padStart(5)}` +
    `${"stones".padStart(8)}${"opener kept".padStart(18)}${"approacher kept".padStart(18)}`,
);
for (const side of ["human", "ai"]) {
  const xs = all.filter((a) => a.side === side && a.spent >= 4);
  const shareOf = (a: Approach) =>
    a.diagonal + a.straight === 0 ? 0 : a.diagonal / (a.diagonal + a.straight);
  for (const [label, pick] of [
    ["mostly diagonal", (a: Approach) => shareOf(a) >= 0.6],
    ["mixed or straight", (a: Approach) => shareOf(a) < 0.6],
  ] as Array<[string, (a: Approach) => boolean]>) {
    const g = xs.filter(pick);
    if (g.length === 0) continue;
    console.log(
      `${side.padEnd(8)}${label.padStart(18)}${String(g.length).padStart(5)}` +
        `${mean(g.map((a) => a.spent)).toFixed(1).padStart(8)}` +
        `${ci(g.map((a) => a.denied)).padStart(18)}${ci(g.map((a) => a.kept)).padStart(18)}`,
    );
  }
}

// The player's correction: the gain from a move is what it took off the other
// side plus what it made for you, not one or the other. Summed that way the
// baseline drops out — the quadrant's net margin, approacher minus opener, needs
// no estimate of what the corner would have been worth untouched, and dividing
// by the stones spent puts approaches of different sizes on the same scale.
console.log(`\nthe two ledgers added: net margin in that quadrant\n`);
console.log(
  `${"side".padEnd(8)}${"stones".padStart(8)}${"n".padStart(5)}${"kept".padStart(8)}` +
    `${"opener kept".padStart(13)}${"net".padStart(16)}${"per stone".padStart(11)}`,
);
for (const side of ["human", "ai"]) {
  const xs = all.filter((a) => a.side === side);
  for (const [label, pick] of [
    ["1-2", (a: Approach) => a.spent <= 2],
    ["3-4", (a: Approach) => a.spent >= 3 && a.spent <= 4],
    ["5+", (a: Approach) => a.spent >= 5],
    ["all", () => true],
  ] as Array<[string, (a: Approach) => boolean]>) {
    const g = xs.filter(pick);
    if (g.length === 0) continue;
    const net = g.map((a) => a.kept - a.denied);
    console.log(
      `${side.padEnd(8)}${label.padStart(8)}${String(g.length).padStart(5)}` +
        `${mean(g.map((a) => a.kept)).toFixed(2).padStart(8)}` +
        `${mean(g.map((a) => a.denied)).toFixed(2).padStart(13)}` +
        `${ci(net).padStart(16)}` +
        `${(mean(net) / mean(g.map((a) => a.spent))).toFixed(2).padStart(11)}`,
    );
  }
}

console.log(`\nand the same net, by how the approach connected (4+ stones)\n`);
console.log(
  `${"side".padEnd(8)}${"connections".padStart(18)}${"n".padStart(5)}${"stones".padStart(8)}` +
    `${"net".padStart(16)}${"per stone".padStart(11)}`,
);
for (const side of ["human", "ai"]) {
  const xs = all.filter((a) => a.side === side && a.spent >= 4);
  const shareOf = (a: Approach) =>
    a.diagonal + a.straight === 0 ? 0 : a.diagonal / (a.diagonal + a.straight);
  for (const [label, pick] of [
    ["mostly diagonal", (a: Approach) => shareOf(a) >= 0.6],
    ["mixed or straight", (a: Approach) => shareOf(a) < 0.6],
  ] as Array<[string, (a: Approach) => boolean]>) {
    const g = xs.filter(pick);
    if (g.length === 0) continue;
    const net = g.map((a) => a.kept - a.denied);
    console.log(
      `${side.padEnd(8)}${label.padStart(18)}${String(g.length).padStart(5)}` +
        `${mean(g.map((a) => a.spent)).toFixed(1).padStart(8)}${ci(net).padStart(16)}` +
        `${(mean(net) / mean(g.map((a) => a.spent))).toFixed(2).padStart(11)}`,
    );
  }
}
