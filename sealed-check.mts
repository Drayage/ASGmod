/**
 * Does the cheap "can this group still breathe more?" test match the real thing?
 *
 * The intended term calls a group sealed when no move raises its liberty count,
 * and wants to decide that from set arithmetic on the group's own liberties
 * rather than by trying every legal move. Two ways that shortcut can be wrong,
 * and they are not symmetric:
 *
 *   missing a friendly join   playing a liberty may connect to another group and
 *                             inherit its liberties
 *   missing a capture         a move elsewhere may take an enemy group and free
 *                             liberties that way
 *
 * Both make a live group look sealed, which is the dangerous direction — the
 * term would score something as dead that is not. So this measures the
 * disagreement against full enumeration over every position of every recorded
 * game, before any of it is wired into the evaluation.
 *
 *   npx vite-node sealed-check.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { getAllGroups, getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

/** Cheap: can playing one of its own liberties leave the group breathing more? */
function cheapCanBreathe(board: Board, group: Coord[], liberties: Set<string>, player: Player): boolean {
  const own = playerCell(player);
  const inGroup = new Set(group.map((s) => `${s.row},${s.col}`));
  for (const filled of liberties) {
    const [row, col] = filled.split(",").map(Number);
    const after = new Set<string>();
    for (const other of liberties) if (other !== filled) after.add(other);
    for (const [dr, dc] of DIRECTIONS) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) continue;
      if (board[r][c] === "EMPTY") after.add(`${r},${c}`);
      else if (board[r][c] === own && !inGroup.has(`${r},${c}`)) {
        // Joining a friendly group brings its liberties along. Counted, because
        // leaving it out would call a group sealed that can walk out.
        for (const key of getGroupLiberties(board, getConnectedGroup(board, r, c))) {
          if (key !== filled) after.add(key);
        }
      }
    }
    if (after.size > liberties.size) return true;
  }
  return false;
}

/**
 * Expensive: try every legal move and see if any leaves it with more.
 *
 * `getLegalMoves`, not `getSafeActions().pool` — the pool is already screened
 * for moves that walk into a capture, so using it as ground truth was hiding
 * escapes from the reference and blaming the shortcut for the gap.
 */
function realCanBreathe(state: GameState, anchor: Coord, before: number, player: Player): boolean {
  for (const move of getLegalMoves(state, player)) {
    const act = { type: "PLACE" as const, row: move.row, col: move.col };
    const next = applyAction(state, act);
    if (next.winner) continue;
    const g = getConnectedGroup(next.board, anchor.row, anchor.col);
    if (g.length > 0 && getGroupLiberties(next.board, g).size > before) return true;
  }
  return false;
}

let checked = 0;
let agree = 0;
let cheapSaysSealedButItCan = 0;
let cheapSaysOpenButItCannot = 0;

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const player: Player = state.currentPlayer;
      for (const group of getAllGroups(state.board, player)) {
        const liberties = getGroupLiberties(state.board, group);
        if (liberties.size === 0 || liberties.size > 3) continue;
        checked += 1;
        const cheap = cheapCanBreathe(state.board, group, liberties, player);
        const real = realCanBreathe(state, group[0], liberties.size, player);
        if (cheap === real) agree += 1;
        else if (!cheap && real) cheapSaysSealedButItCan += 1;
        else cheapSaysOpenButItCannot += 1;
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

const pct = (n: number) => `${((n / checked) * 100).toFixed(2)}%`;
console.log(`groups at 3 liberties or fewer, checked both ways: ${checked}\n`);
console.log(`  agree                                 ${agree}  (${pct(agree)})`);
console.log(`  cheap says sealed, really can breathe ${cheapSaysSealedButItCan}  (${pct(cheapSaysSealedButItCan)})   <- the harmful one`);
console.log(`  cheap says open, really cannot        ${cheapSaysOpenButItCannot}  (${pct(cheapSaysOpenButItCannot)})   <- merely a miss`);
