/**
 * The sharp version: moves that cost a group its last chance of an eye.
 *
 * The loose metric — "played on a point that could have become an eye" — counts
 * every benign fill alongside the fatal ones, and it has already disagreed with
 * itself across builds by a factor of ten. It should not have been offered as
 * the thing to judge on.
 *
 * This is what actually happened in the two traced games: before the move the
 * group could still enclose an eye within two of its own moves, and after it
 * could not. Nothing else counts.
 *
 *   npx vite-node blinding.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { getAllGroups, getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { coordKeySet } from "./src/games/alley-boss-cats/territory";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

/** Has this group a liberty inside its owner's confirmed territory? */
function alive(state: GameState, anchor: Coord, player: Player): boolean {
  const g = getConnectedGroup(state.board, anchor.row, anchor.col);
  if (g.length === 0) return false;
  const own = coordKeySet(state.territories[player]);
  for (const key of getGroupLiberties(state.board, g)) if (own.has(key)) return true;
  return false;
}

/** Can this group get an eye within two of its own moves, unopposed? */
function eyeWithinTwo(state: GameState, anchor: Coord, player: Player): boolean {
  if (alive(state, anchor, player)) return true;
  for (const a of getLegalMoves(state, player)) {
    const s1 = applyAction({ ...state, currentPlayer: player }, { type: "PLACE", row: a.row, col: a.col });
    if (s1.winner) continue;
    if (alive(s1, anchor, player)) return true;
    for (const b of getLegalMoves(s1, player)) {
      const s2 = applyAction({ ...s1, currentPlayer: player }, { type: "PLACE", row: b.row, col: b.col });
      if (!s2.winner && alive(s2, anchor, player)) return true;
    }
  }
  return false;
}

const stats = new Map<string, { games: number; moves: number; blinding: number }>();
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const key = `${rec.appVersion ?? "?"} / ${rec.aiVariant ?? "(pre-variant)"}`;
    const t = stats.get(key) ?? { games: 0, moves: 0, blinding: 0 };
    stats.set(key, t);
    t.games += 1;
    const human: Player = rec.playerSide;
    const ai = opponent(human);

    let state: GameState = createInitialState();
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      if (state.currentPlayer === ai && m.type === "PLACE") {
        t.moves += 1;
        // Only groups thin enough for life to be the question.
        const watched = getAllGroups(state.board, ai)
          .filter((g) => getGroupLiberties(state.board, g).size <= 3)
          .map((g) => g[0]);
        const before = watched.filter((a) => eyeWithinTwo(state, a, ai));
        if (before.length > 0) {
          const after = applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
          if (!after.winner) {
            for (const anchor of before) {
              const still = getConnectedGroup(after.board, anchor.row, anchor.col);
              if (still.length === 0) continue;
              if (!eyeWithinTwo(after, anchor, ai)) { t.blinding += 1; break; }
            }
          }
        }
      }
      state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
    }
  }
}

console.log(`moves that cost one of the AI's own thin groups its last eye chance\n`);
console.log(`${"build / variant".padEnd(26)}${"games".padStart(7)}${"moves".padStart(7)}${"blinding".padStart(10)}${"per game".padStart(10)}`);
for (const [k, t] of [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(
    `${k.padEnd(26)}${String(t.games).padStart(7)}${String(t.moves).padStart(7)}` +
      `${String(t.blinding).padStart(10)}${(t.blinding / t.games).toFixed(2).padStart(10)}`,
  );
}
