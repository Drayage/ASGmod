/**
 * Could the group that died have made an eye instead of running?
 *
 * The player's hypothesis: when a group has no friend to connect to, the move
 * is to enclose a point of its own — diagonally, with as few stones as possible
 * — rather than to keep extending. In this game that is decisive, because
 * confirmed territory can never be played by either side, so a single eye makes
 * a group permanently safe. `shapeStats` already calls that `immortal`.
 *
 * The engine scores `mine.immortal * 30` for having one and nothing at all for
 * being one move away from having one. This asks whether the chance was there.
 *
 * For each engine turn while the group is thin: does any single move make it
 * immortal, and failing that, does any pair of its own moves.
 *
 *   npx vite-node eye-chance.mts <export.json>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { coordKeySet } from "./src/games/alley-boss-cats/territory";
import { opponent } from "./src/games/alley-boss-cats/types";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

const C = "ABCDEFGHI";
const nm = (r: number, c: number) => `${C[c]}${r + 1}`;
const F = process.argv[2]!;

/** Does this group hold a liberty inside its owner's confirmed territory? */
function immortal(state: GameState, anchor: { row: number; col: number }, player: Player): boolean {
  const g = getConnectedGroup(state.board, anchor.row, anchor.col);
  if (g.length === 0) return false;
  const own = coordKeySet(state.territories[player]);
  for (const key of getGroupLiberties(state.board, g)) if (own.has(key)) return true;
  return false;
}

for (const [game, point] of [["1", "C8"], ["2", "D8"]] as const) {
  const rec = (JSON.parse(readFileSync(F, "utf8")) as { records: any[] }).records[Number(game) - 1];
  const human: Player = rec.playerSide;
  const ai = opponent(human);
  const anchor = { row: Number(point.slice(1)) - 1, col: C.indexOf(point[0]) };
  console.log(`\ngame ${game}, group ${point} (AI = ${ai})`);

  let state: GameState = createInitialState();
  for (const m of rec.moveHistory) {
    if (state.winner) break;
    if (state.currentPlayer === ai) {
      const g = getConnectedGroup(state.board, anchor.row, anchor.col);
      const libs = g.length ? getGroupLiberties(state.board, g).size : 0;
      if (g.length > 0 && libs <= 4) {
        const one: string[] = [];
        const two: string[] = [];
        for (const a of getLegalMoves(state, ai)) {
          const s1 = applyAction(state, { type: "PLACE", row: a.row, col: a.col });
          if (s1.winner) continue;
          if (immortal(s1, anchor, ai)) { one.push(nm(a.row, a.col)); continue; }
          if (one.length) continue;
          // Two of its own moves in a row — the opponent gets one in between, so
          // this is the optimistic reading, and labelled as such below.
          for (const b of getLegalMoves(s1, ai)) {
            const s2 = applyAction({ ...s1, currentPlayer: ai }, { type: "PLACE", row: b.row, col: b.col });
            if (!s2.winner && immortal(s2, anchor, ai)) {
              two.push(`${nm(a.row, a.col)}+${nm(b.row, b.col)}`);
              break;
            }
          }
        }
        const verdict = one.length
          ? `EYE IN ONE: ${one.slice(0, 6).join(" ")}`
          : two.length
            ? `eye in two (unopposed): ${two.slice(0, 4).join(" ")}`
            : "no eye within two moves";
        const played = m.type === "PLACE" ? nm(m.row!, m.col!) : "PASS";
        console.log(`  turn ${String(m.turn).padStart(2)}  libs ${libs}  played ${played.padEnd(4)}  ${verdict}`);
      }
    }
    state = m.type === "PASS" ? applyAction(state, { type: "PASS" })
      : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
  }
}
