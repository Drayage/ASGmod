/**
 * What sits behind the pocket at the moment it is declined.
 *
 * Declining is not the difference: both sides decline at the same rate, and
 * both come back — the engine sooner (2.6 of its own moves against 3.6) and
 * more often immediately. Yet the human's declined cells are kept 88% of the
 * time and grow into something bigger 28% of the time, against 71% and 15%.
 *
 * "Draw small, and take the bigger frame if the opponent does not contest it"
 * only works when there is a bigger frame to take. So this looks at the open
 * space the declined pocket belongs to: flood the empties outward from it, and
 * ask how large that room is and who borders it.
 *
 *   npx vite-node decline-room.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { findSealingMoves } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const MIN_CELLS = Number(process.env.MIN_CELLS ?? 2);

/** The empty region reachable from `seeds`, and who walls it. */
function room(board: Board, seeds: Coord[], mover: Player) {
  const mine = playerCell(mover);
  const theirs = playerCell(opponent(mover));
  const seen = new Set(seeds.map((c) => `${c.row},${c.col}`));
  const stack = [...seeds];
  let size = 0;
  let mineBorder = 0;
  let theirsBorder = 0;
  let edge = 0;
  while (stack.length) {
    const cur = stack.pop()!;
    size += 1;
    for (const [dr, dc] of DIRECTIONS) {
      const r = cur.row + dr, c = cur.col + dc;
      if (!inBounds(r, c)) { edge += 1; continue; }
      const cell = board[r][c];
      if (cell === mine) { mineBorder += 1; continue; }
      if (cell === theirs) { theirsBorder += 1; continue; }
      const k = `${r},${c}`;
      if (!seen.has(k)) { seen.add(k); stack.push({ row: r, col: c }); }
    }
  }
  return { size, mineBorder, theirsBorder, edge };
}

interface Side {
  n: number;
  pocket: number[];
  roomSize: number[];
  headroom: number[];
  mineShare: number[];
}
const blank = (): Side => ({ n: 0, pocket: [], roomSize: [], headroom: [], mineShare: [] });
const sides: Record<string, Side> = { human: blank(), ai: blank() };

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    const human: Player = rec.playerSide;

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const before = state;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (m.type !== "PLACE") continue;

      const seals = findSealingMoves(before, mover).filter((s) => s.gained.length >= MIN_CELLS);
      if (seals.length === 0) continue;
      if (seals.some((s) => s.move.row === m.row && s.move.col === m.col)) continue;

      // The room the pocket opens onto, measured on the board as it stood —
      // with the seal point still empty, since declining is what leaves it so.
      const best = seals[0];
      const r = room(before.board, [...best.gained, best.move], mover);
      const side = sides[mover === human ? "human" : "ai"];
      side.n += 1;
      side.pocket.push(best.gained.length);
      side.roomSize.push(r.size);
      side.headroom.push(r.size - best.gained.length);
      const walls = r.mineBorder + r.theirsBorder + r.edge;
      side.mineShare.push(walls ? (r.mineBorder + r.edge) / walls : 0);
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
console.log(`the open space a declined ${MIN_CELLS}+ cell pocket opens onto\n`);
console.log(
  `${"side".padEnd(8)}${"declines".padStart(10)}${"pocket".padStart(9)}${"room".padStart(9)}` +
    `${"room, median".padStart(14)}${"headroom".padStart(10)}${"mine+edge share".padStart(17)}`,
);
for (const [name, s] of Object.entries(sides)) {
  console.log(
    `${name.padEnd(8)}${String(s.n).padStart(10)}${mean(s.pocket).toFixed(1).padStart(9)}` +
      `${mean(s.roomSize).toFixed(1).padStart(9)}${median(s.roomSize).toFixed(0).padStart(14)}` +
      `${mean(s.headroom).toFixed(1).padStart(10)}` +
      `${`${(mean(s.mineShare) * 100).toFixed(0)}%`.padStart(17)}`,
  );
}
