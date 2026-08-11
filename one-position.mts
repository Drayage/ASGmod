/**
 * One position, every legal move, sorted by what it settles.
 *
 * The player pointed at a specific move rather than a pattern: at ply 23 of the
 * game they sent, the engine played 1행 4열 and they say a stone two rows lower
 * does everything that one did and encloses three more, at no extra risk.
 *
 * A general statistic cannot answer that. This replays their game to the ply
 * they named and asks the rules directly, for every move the engine could have
 * played: how many cells it settles now, whether the opponent can force a
 * capture against it afterwards, and what the whole board's confirmed count
 * would be. Then it replays the engine on the position to see which stage chose
 * and whether it still chooses the same thing.
 *
 *   PLY=23 npx vite-node one-position.mts <export.json>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { opponentCanForceCapture } from "./src/games/alley-boss-cats/engine/captureSearch";
import { findBestMoveVeryHard, lastDecision } from "./src/games/alley-boss-cats/engine/minimax";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { createInitialState, getLegalMoves } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { applyAIVariant } from "./src/games/alley-boss-cats/aiVariant";
import type { AIVariant } from "./src/games/alley-boss-cats/aiVariant";
import { playerCell } from "./src/games/alley-boss-cats/types";
import type { GameState } from "./src/games/alley-boss-cats/types";

const PLY = Number(process.env.PLY ?? 23);
const THINK = Number(process.env.THINK ?? 3000);
const TOP = Number(process.env.TOP ?? 12);

const rec = (JSON.parse(readFileSync(process.argv[2], "utf8")) as { records: any[] }).records[
  Number(process.env.GAME ?? 0)
];
applyAIVariant((rec.aiVariant ?? "EYE") as AIVariant);

let state: GameState = createInitialState();
let played: { row: number; col: number } | null = null;
for (let i = 0; i < rec.moveHistory.length; i += 1) {
  const m = rec.moveHistory[i];
  if (i + 1 === PLY) {
    played = m.type === "PLACE" ? { row: m.row, col: m.col } : null;
    break;
  }
  state = m.type === "PASS"
    ? applyAction(state, { type: "PASS" })
    : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
}

const mover = state.currentPlayer;
const before = state.territories[mover].length;
const theirs = state.territories[mover === "A" ? "B" : "A"].length;

const show = (row: number, col: number) => `${row + 1}행 ${col + 1}열`;

console.log(`${rec.aiVariant ?? "?"} · ply ${PLY} · ${mover} to move`);
console.log(`settled so far: ${mover} ${before}, other side ${theirs}`);
console.log(`they played ${played ? show(played.row, played.col) : "PASS"}\n`);

interface Option { row: number; col: number; settles: number; safe: boolean; room: number }
const options: Option[] = [];
for (const mv of getLegalMoves(state, mover)) {
  const board = state.board.map((r) => [...r]);
  board[mv.row][mv.col] = playerCell(mover);
  const territories = calculateTerritories(board);
  const next: GameState = { ...state, board, territories, currentPlayer: mover === "A" ? "B" : "A" };
  options.push({
    row: mv.row,
    col: mv.col,
    settles: territories[mover].length - before,
    safe: !next.winner && !opponentCanForceCapture(next, mover, 9, 800),
    room: getGroupLiberties(board, getConnectedGroup(board, mv.row, mv.col)).size,
  });
}
options.sort((a, b) => b.settles - a.settles || Number(b.safe) - Number(a.safe));

console.log(`${"move".padEnd(12)}${"settles now".padStart(13)}${"safe".padStart(7)}${"liberties".padStart(11)}`);
for (const o of options.slice(0, TOP)) {
  const mark = played && o.row === played.row && o.col === played.col ? "  <- played" : "";
  console.log(
    `${show(o.row, o.col).padEnd(12)}${String(o.settles).padStart(13)}` +
      `${(o.safe ? "yes" : "NO").padStart(7)}${String(o.room).padStart(11)}${mark}`,
  );
}
if (played) {
  const rank = options.findIndex((o) => o.row === played!.row && o.col === played!.col);
  const it = options[rank];
  console.log(
    `\nthe move played ranks ${rank + 1} of ${options.length} by cells settled` +
      ` (${it.settles}, safe ${it.safe ? "yes" : "no"}, ${it.room} liberties)`,
  );
  const best = options[0];
  console.log(
    `the most it could have settled was ${best.settles} at ${show(best.row, best.col)}` +
      ` (safe ${best.safe ? "yes" : "no"}, ${best.room} liberties)`,
  );
}

const pick = findBestMoveVeryHard(state, mover, THINK);
console.log(
  `\nreplayed now it plays ${pick.type === "PLACE" ? show(pick.row, pick.col) : "PASS"}` +
    `, chosen by ${lastDecision.stage}`,
);
