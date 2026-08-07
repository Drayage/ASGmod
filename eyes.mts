/**
 * Does the engine ever make an eye?
 *
 * This game is not Go on that point. Confirmed territory is unplayable by
 * *either* side, so a group holding one territory point as a liberty can never
 * be reduced to zero — one eye is life, not two. `hasTerritoryLiberty` already
 * encodes the positive half of that.
 *
 * Which raises a question nothing has asked: how often does either side
 * actually have one? An eye is worth two things at once here — it is life for
 * the group, and it is a point of territory — so a side that never makes one
 * is losing on both counts with a single omission.
 *
 * Counted over the recorded games, per side, at every position from ply 12:
 * groups alive by eye, eyes held, and how much of each side's territory is
 * doing that job rather than sitting in open space.
 *
 *   npx vite-node eyes.mts
 */
import { readFileSync, existsSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { getAllGroups, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { coordKeySet } from "./src/games/alley-boss-cats/territory";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";
import { summarize } from "./arena-aggregate";
import { DEFAULT_SEED_FILES } from "./arena-seeds";

interface Move {
  type: string;
  row?: number;
  col?: number;
}
interface Record_ {
  playerSide?: Player;
  firstRole?: string;
  secondRole?: string;
  moveHistory: Move[];
}

interface Bucket {
  /** Groups with a liberty inside their own territory — alive outright. */
  aliveGroups: number[];
  /** Territory points serving as some group's liberty. */
  eyes: number[];
  territory: number[];
  /** Positions where the side had at least one eye. */
  positionsWithEye: number;
  positions: number;
  /** First ply at which the side ever held an eye, per game. */
  firstEyePly: number[];
}
const blank = (): Bucket => ({
  aliveGroups: [],
  eyes: [],
  territory: [],
  positionsWithEye: 0,
  positions: 0,
  firstEyePly: [],
});
const stats = new Map<string, Bucket>();
const bucket = (label: string) => {
  const found = stats.get(label);
  if (found) return found;
  const made = blank();
  stats.set(label, made);
  return made;
};

/** Territory points of `player` that are a liberty of one of their groups. */
function eyesOf(state: GameState, player: Player): { eyes: number; aliveGroups: number } {
  const own = coordKeySet(state.territories[player]);
  if (own.size === 0) return { eyes: 0, aliveGroups: 0 };
  const eyes = new Set<string>();
  let aliveGroups = 0;
  for (const group of getAllGroups(state.board, player)) {
    let alive = false;
    for (const liberty of getGroupLiberties(state.board, group)) {
      if (!own.has(liberty)) continue;
      eyes.add(liberty);
      alive = true;
    }
    if (alive) aliveGroups += 1;
  }
  return { eyes: eyes.size, aliveGroups };
}

const files = DEFAULT_SEED_FILES.filter((path) => existsSync(path));

for (const path of files) {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { records: Record_[] };
  for (const record of parsed.records) {
    const labels: Record<Player, string> | null =
      record.firstRole && record.secondRole
        ? ({ A: record.firstRole, B: record.secondRole } as Record<Player, string>)
        : record.playerSide
          ? ({
              [record.playerSide]: "human",
              [record.playerSide === "A" ? "B" : "A"]: "engine",
            } as Record<Player, string>)
          : null;
    if (!labels) continue;

    let state: GameState = createInitialState();
    let ply = 0;
    const firstEye: Record<Player, number | null> = { A: null, B: null };

    for (const move of record.moveHistory) {
      if (state.winner) break;
      state =
        move.type === "PASS"
          ? applyAction(state, { type: "PASS" })
          : applyAction(state, { type: "PLACE", row: move.row!, col: move.col! });
      ply += 1;

      for (const side of ["A", "B"] as const) {
        const { eyes, aliveGroups } = eyesOf(state, side);
        if (eyes > 0 && firstEye[side] === null) firstEye[side] = ply;
        if (ply < 12) continue;
        const into = bucket(labels[side]);
        into.positions += 1;
        into.eyes.push(eyes);
        into.aliveGroups.push(aliveGroups);
        into.territory.push(state.territories[side].length);
        if (eyes > 0) into.positionsWithEye += 1;
      }
    }
    for (const side of ["A", "B"] as const) {
      if (firstEye[side] !== null) bucket(labels[side]).firstEyePly.push(firstEye[side]!);
    }
  }
}

const mean = (values: number[]) => summarize(values).mean ?? 0;
console.log(`recorded games from ${files.length} file(s), positions from ply 12\n`);
console.log(
  `${"".padEnd(10)}${"positions".padStart(11)}${"with an eye".padStart(13)}` +
    `${"eyes".padStart(8)}${"alive groups".padStart(14)}${"territory".padStart(11)}` +
    `${"eyes/territory".padStart(16)}${"first eye".padStart(11)}`,
);
for (const [label, b] of stats) {
  const eyes = mean(b.eyes);
  const territory = mean(b.territory);
  console.log(
    `${label.padEnd(10)}${String(b.positions).padStart(11)}` +
      `${`${((b.positionsWithEye / b.positions) * 100).toFixed(1)}%`.padStart(13)}` +
      `${eyes.toFixed(2).padStart(8)}` +
      `${mean(b.aliveGroups).toFixed(2).padStart(14)}` +
      `${territory.toFixed(2).padStart(11)}` +
      `${(territory === 0 ? "—" : `${((eyes / territory) * 100).toFixed(1)}%`).padStart(16)}` +
      `${(b.firstEyePly.length === 0 ? "never" : `ply ${mean(b.firstEyePly).toFixed(1)}`).padStart(11)}`,
  );
}
