/**
 * Does the engine fill in the space it already owns?
 *
 * Turn by turn the engine dominates *more* loose space than the human through
 * the middle game — 21.8 empty cells against 14.0 at turns 31-40 — and ends
 * with 1.5 cells in regions of six or more against the human's 7.0. The space
 * is there and it does not become territory, so the loss happens in between.
 *
 * One way to lose it is to spend it: a stone played inside a room you already
 * dominate costs a cell of that room and buys nothing, because the cell was
 * going to be yours at the count. So this asks how often each side does that,
 * and how much room each such move consumes.
 *
 *   npx vite-node room-fill.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const BANDS = [1, 11, 21, 31, 41, 51] as const;
/** A room this size or larger is worth not spending. */
const BIG_ROOM = Number(process.env.BIG_ROOM ?? 6);

/** The empty room containing `at`, and whether `side` dominates it. */
function roomAt(board: Board, at: Coord, side: Player) {
  const mine = playerCell(side);
  const theirs = playerCell(opponent(side));
  const seen = new Set([`${at.row},${at.col}`]);
  const stack = [at];
  let size = 0;
  let ours = 0;
  let enemy = 0;
  while (stack.length) {
    const cur = stack.pop()!;
    size += 1;
    for (const [dr, dc] of DIRECTIONS) {
      const r = cur.row + dr, c = cur.col + dc;
      if (!inBounds(r, c)) { ours += 1; continue; }
      const cell = board[r][c];
      if (cell === mine) { ours += 1; continue; }
      if (cell === theirs) { enemy += 1; continue; }
      const k = `${r},${c}`;
      if (!seen.has(k)) { seen.add(k); stack.push({ row: r, col: c }); }
    }
  }
  return { size, dominated: ours > enemy };
}

const bandOf = (turn: number) => {
  for (let i = BANDS.length - 1; i >= 0; i -= 1) if (turn >= BANDS[i]) return i;
  return 0;
};
const label = (i: number) => (i === BANDS.length - 1 ? `${BANDS[i]}+` : `${BANDS[i]}-${BANDS[i + 1] - 1}`);

/**
 * `inside` alone would overstate the case: a room has to be divided by playing
 * in it, and a wall along its rim is exactly how ground gets closed. What is
 * hard to defend is a stone with no enemy stone anywhere beside it, dropped in
 * space that was already going to be counted for the mover.
 */
interface Side { moves: number[]; inside: number[]; insideBig: number[]; idle: number[] }
const blank = (): Side => ({
  moves: new Array(BANDS.length).fill(0),
  inside: new Array(BANDS.length).fill(0),
  insideBig: new Array(BANDS.length).fill(0),
  idle: new Array(BANDS.length).fill(0),
});
const sides: Record<string, Side> = { human: blank(), ai: blank() };
let games = 0;

const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    games += 1;
    const humanSide: Player = rec.playerSide;

    let state: GameState = createInitialState();
    let turn = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const before = state;
      turn += 1;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      if (m.type !== "PLACE") continue;

      const side = sides[mover === humanSide ? "human" : "ai"];
      const b = bandOf(turn);
      side.moves[b] += 1;
      const r = roomAt(before.board, { row: m.row!, col: m.col! }, mover);
      if (r.dominated) {
        side.inside[b] += 1;
        if (r.size >= BIG_ROOM) {
          side.insideBig[b] += 1;
          const enemy = playerCell(opponent(mover));
          let touchesEnemy = false;
          for (const [dr, dc] of DIRECTIONS) {
            const rr = m.row! + dr, cc = m.col! + dc;
            if (inBounds(rr, cc) && before.board[rr][cc] === enemy) { touchesEnemy = true; break; }
          }
          if (!touchesEnemy) side.idle[b] += 1;
        }
      }
    }
  }
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
console.log(
  `stones played inside a room the mover already dominates, ${games} games decided by the count\n`,
);
console.log(`${"".padEnd(22)}${BANDS.map((_, i) => label(i).padStart(9)).join("")}`);
for (const [name, s] of Object.entries(sides)) {
  console.log(
    `${`${name}, any room`.padEnd(22)}` +
      s.inside.map((c, i) => pct(c, s.moves[i]).padStart(9)).join(""),
  );
  console.log(
    `${`${name}, room of ${BIG_ROOM}+`.padEnd(22)}` +
      s.insideBig.map((c, i) => pct(c, s.moves[i]).padStart(9)).join(""),
  );
  console.log(
    `${`${name}, ...no contact`.padEnd(22)}` +
      s.idle.map((c, i) => pct(c, s.moves[i]).padStart(9)).join(""),
  );
}
