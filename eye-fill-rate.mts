/**
 * How often does each side play on a point that could have been its own eye?
 *
 * The two lost games both turned on a single move of this kind. Before building
 * anything, count it — and count it for the person too, since "the engine does
 * something a good player also does" would end the idea straight away.
 *
 * An eye candidate for `player` is an empty point that
 *   - is a liberty of one of their groups,
 *   - has no enemy stone beside it, so they could enclose it, and
 *   - has at most two empty neighbours, so enclosing it is one or two moves.
 *
 * Playing it is what killed both groups: the point stops being enclosable
 * ground and becomes another stone in the same shrinking shape.
 *
 * Reported separately for groups already at three liberties or fewer, which is
 * where it decides the game rather than merely wasting a point.
 *
 *   npx vite-node eye-fill-rate.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { getAllGroups, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

interface Side { moves: number; filled: number; filledThin: number; hadChance: number }
const blank = (): Side => ({ moves: 0, filled: 0, filledThin: 0, hadChance: 0 });
const stats = new Map<string, { ai: Side; human: Side; games: number }>();
const C = "ABCDEFGHI";

/** Eye candidates for `player`, and whether the group holding them is thin. */
function eyeCandidates(state: GameState, player: Player): Map<string, boolean> {
  const own = playerCell(player);
  const enemy = playerCell(opponent(player));
  const out = new Map<string, boolean>();
  for (const group of getAllGroups(state.board, player)) {
    const liberties = getGroupLiberties(state.board, group);
    const thin = liberties.size <= 3;
    for (const key of liberties) {
      const [row, col] = key.split(",").map(Number);
      let empties = 0;
      let enemyBeside = false;
      for (const [dr, dc] of DIRECTIONS) {
        const r = row + dr;
        const c = col + dc;
        if (!inBounds(r, c)) continue;
        if (state.board[r][c] === enemy) { enemyBeside = true; break; }
        if (state.board[r][c] === "EMPTY") empties += 1;
      }
      if (enemyBeside || empties > 2) continue;
      out.set(key, (out.get(key) ?? false) || thin);
    }
  }
  return out;
}

// The exports overlap — the same game appears in several of them — so count
// each recorded game once. Without this the busiest build is counted twice.
const seenGames = new Set<string>();
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seenGames.has(rec.id)) continue;
    if (rec.id) seenGames.add(rec.id);
    const build = rec.appVersion ?? "?";
    const slot = stats.get(build) ?? { ai: blank(), human: blank(), games: 0 };
    stats.set(build, slot);
    slot.games += 1;
    const human: Player = rec.playerSide;
    const ai = opponent(human);

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      const mover = state.currentPlayer;
      const side = mover === ai ? slot.ai : slot.human;
      side.moves += 1;
      if (m.type === "PLACE") {
        const candidates = eyeCandidates(state, mover);
        if (candidates.size > 0) side.hadChance += 1;
        const key = `${m.row},${m.col}`;
        if (candidates.has(key)) {
          side.filled += 1;
          if (candidates.get(key)) side.filledThin += 1;
        }
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
console.log(
  `${"build".padEnd(10)}${"side".padEnd(7)}${"moves".padStart(7)}${"filled an eye point".padStart(21)}` +
    `${"...of a thin group".padStart(20)}${"per game".padStart(10)}`,
);
for (const [build, s] of [...stats.entries()].sort((a, b) => a[1].games - b[1].games)) {
  for (const [who, d] of [["AI", s.ai], ["human", s.human]] as const) {
    console.log(
      `${build.padEnd(10)}${who.padEnd(7)}${String(d.moves).padStart(7)}` +
        `${`${d.filled} (${pct(d.filled, d.moves)})`.padStart(21)}` +
        `${`${d.filledThin} (${pct(d.filledThin, d.moves)})`.padStart(20)}` +
        `${(d.filledThin / s.games).toFixed(2).padStart(10)}`,
    );
  }
}
