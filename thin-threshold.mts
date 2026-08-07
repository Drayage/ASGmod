/**
 * How much of stage 1.75's firing is real danger, and how much is a group with
 * three liberties?
 *
 * `thinGroupDanger` fires on any own group at or below
 * THIN_GROUP_LIBERTY_THRESHOLD liberties with an opponent stone beside one of
 * them, and no proof of anything. It decides 23.8% of the engine's moves. The
 * threshold is 3, and three liberties is thin but not urgent here: taking such
 * a group needs three opponent moves against two replies.
 *
 * So split the firing by the liberty count that triggered it. If most of it is
 * threes, lowering the threshold to 2 hands those moves back to the full search
 * while keeping the guard for groups that are genuinely one move from atari —
 * a far smaller change than switching the guard off.
 *
 * Board analysis only, no search, so this can run alongside an arena.
 *
 *   npx vite-node thin-threshold.mts [export.json ...]
 */
import { readFileSync, existsSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { getAllGroups, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
import { DEFAULT_SEED_FILES } from "./arena-seeds";

interface Move {
  type: string;
  row?: number;
  col?: number;
}
interface Record_ {
  playerSide?: Player;
  moveHistory: Move[];
}

/** The guard's own trigger test, reproduced: smallest liberty count among the
 * mover's groups that are thin, not territory-safe, and bordered. Null when
 * nothing fires. */
function triggerLiberties(state: GameState, player: Player, threshold: number): number | null {
  const opponentCell = playerCell(opponent(player));
  const ownTerritory = new Set(state.territories[player].map((c) => `${c.row},${c.col}`));
  let smallest: number | null = null;

  for (const group of getAllGroups(state.board, player)) {
    const liberties = getGroupLiberties(state.board, group);
    if (liberties.size === 0 || liberties.size > threshold) continue;
    if ([...liberties].some((l) => ownTerritory.has(l))) continue;
    const underPressure = [...liberties].some((libertyKey) => {
      const [row, col] = libertyKey.split(",").map(Number);
      return DIRECTIONS.some(([dr, dc]) => {
        const r = row + dr;
        const c = col + dc;
        return inBounds(r, c) && state.board[r][c] === opponentCell;
      });
    });
    if (!underPressure) continue;
    if (smallest === null || liberties.size < smallest) smallest = liberties.size;
  }
  return smallest;
}

const files = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SEED_FILES).filter(
  (path) => existsSync(path),
);

let turns = 0;
const byLiberties = new Map<number, number>();

for (const path of files) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };
  for (const record of parsed.records) {
    if (!record.playerSide) continue;
    const ai = opponent(record.playerSide);
    let state: GameState = createInitialState();
    for (const move of record.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === ai) {
        turns += 1;
        const trigger = triggerLiberties(state, ai, 3);
        if (trigger !== null) byLiberties.set(trigger, (byLiberties.get(trigger) ?? 0) + 1);
      }
      state =
        move.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
    }
  }
}

const pct = (n: number) => `${((n / turns) * 100).toFixed(1)}%`;
console.log(`${turns} AI turns from ${files.length} file(s)\n`);
console.log(`stage 1.75 would trigger on, by the thinnest group's liberty count:`);
let cumulative = 0;
for (const libs of [1, 2, 3]) {
  const count = byLiberties.get(libs) ?? 0;
  cumulative += count;
  console.log(`  ${libs} libert${libs === 1 ? "y" : "ies"}: ${String(count).padStart(4)}  ${pct(count).padStart(7)}`);
}
console.log(`  ${"total".padEnd(10)} ${String(cumulative).padStart(4)}  ${pct(cumulative).padStart(7)}`);

const threes = byLiberties.get(3) ?? 0;
console.log(
  `\nlowering the threshold from 3 to 2 would hand ${threes} turns (${pct(threes)} of all` +
    ` AI moves) back to the full search, and keep the guard on the other ${cumulative - threes}.`,
);
