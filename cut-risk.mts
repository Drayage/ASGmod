/**
 * Is the diagonal bonus getting the engine captured?
 *
 * The player's report, and the record backs the impression: the engine lost by
 * capture in 3 of 6 games on EYE_CORNER_DIAG, against 0 of 5 on EYE_CORNER. The
 * arena said the opposite — the diagonal side lost 45 groups to the plain
 * engine's 59 — but the arena is engine against engine, and a diagonal join is
 * a shape with a cutting point in it. Whether that costs anything depends on
 * whether the opponent goes for the cut, and the engine may simply not.
 *
 * So this measures the shape rather than the outcome. A stone is loose when it
 * has a diagonal friend and no orthogonal one: connected by intention, not by
 * the rules. The count of those, and of the cutting points beside them that the
 * opponent could actually play, is what the bonus should have moved — and if
 * the captures are its doing, the group that died should have been one of them.
 *
 *   npx vite-node cut-risk.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { getConnectedGroup, getGroupLiberties } from "./src/games/alley-boss-cats/groups";
import { createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import { opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, GameState, Player } from "./src/games/alley-boss-cats/types";

const FROM = Number(process.env.FROM ?? 10);

const STRAIGHT = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
const DIAGONAL = [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const;
const inside = (r: number, c: number) => r >= 0 && r < 9 && c >= 0 && c < 9;

/** Stones joined only diagonally, and the points where that join can be cut. */
function looseShape(board: Board, side: Player): { loose: number; stones: number; cuts: number } {
  const mine = playerCell(side);
  let loose = 0;
  let stones = 0;
  const cuts = new Set<string>();
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      if (board[row][col] !== mine) continue;
      stones += 1;
      const straight = STRAIGHT.some(([dr, dc]) =>
        inside(row + dr, col + dc) && board[row + dr][col + dc] === mine);
      const diagonal = DIAGONAL.some(([dr, dc]) =>
        inside(row + dr, col + dc) && board[row + dr][col + dc] === mine);
      if (diagonal && !straight) loose += 1;
      // The two shared neighbours of a diagonal pair are its cutting points.
      for (const [dr, dc] of DIAGONAL) {
        const r = row + dr;
        const c = col + dc;
        if (!inside(r, c) || board[r][c] !== mine) continue;
        for (const [er, ec] of [[row, c], [r, col]] as Array<[number, number]>) {
          if (board[er][ec] === "EMPTY") cuts.add(`${er},${ec}`);
        }
      }
    }
  }
  return { loose, stones, cuts: cuts.size };
}

interface Game { variant: string; loose: number[]; cuts: number[]; died?: string }
const games: Game[] = [];
const seen = new Set<string>();

for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    const human: Player = rec.playerSide;
    const engine = opponent(human);
    const game: Game = { variant: rec.aiVariant ?? "(older)", loose: [], cuts: [] };

    let state: GameState = createInitialState();
    let ply = 0;
    for (const m of rec.moveHistory) {
      if (state.winner) break;
      state = m.type === "PASS"
        ? applyAction(state, { type: "PASS" })
        : applyAction(state, { type: "PLACE", row: m.row!, col: m.col! });
      ply += 1;
      if (ply < FROM) continue;
      const shape = looseShape(state.board, engine);
      if (shape.stones > 0) {
        game.loose.push(shape.loose / shape.stones);
        game.cuts.push(shape.cuts);
      }
    }

    // What died, when something did. A captured group is left standing and
    // recorded, so the shape that lost the game can be read straight off it.
    if (state.capturedGroup && state.winner === human) {
      const group = state.capturedGroup as Array<{ row: number; col: number }>;
      const before = state.board.map((r) => [...r]);
      for (const c of group) before[c.row][c.col] = playerCell(engine);
      let straight = 0;
      for (const c of group) {
        if (STRAIGHT.some(([dr, dc]) =>
          inside(c.row + dr, c.col + dc) &&
          group.some((g) => g.row === c.row + dr && g.col === c.col + dc))) straight += 1;
      }
      game.died = `${group.length} stone(s), ${straight} of them joined orthogonally`;
    }
    games.push(game);
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const ci = (xs: number[]) => {
  if (xs.length < 2) return "-";
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  return `${m.toFixed(3)} +/- ${((1.96 * sd) / Math.sqrt(xs.length)).toFixed(3)}`;
};

console.log(`the engine's shape from ply ${FROM} on, by variant\n`);
console.log(
  `${"variant".padEnd(18)}${"games".padStart(7)}${"loose stone share".padStart(22)}` +
    `${"open cutting points".padStart(22)}`,
);
const byVariant = new Map<string, Game[]>();
for (const g of games) byVariant.set(g.variant, [...(byVariant.get(g.variant) ?? []), g]);
for (const [variant, gs] of [...byVariant.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(
    `${variant.padEnd(18)}${String(gs.length).padStart(7)}` +
      `${ci(gs.map((g) => mean(g.loose))).padStart(22)}` +
      `${ci(gs.map((g) => mean(g.cuts))).padStart(22)}`,
  );
}

console.log(`\nwhat died, in the games the engine lost by capture\n`);
for (const g of games) {
  if (!g.died) continue;
  console.log(`  ${g.variant.padEnd(18)}${g.died}`);
}

void getConnectedGroup;
void getGroupLiberties;
void isLegalMove;
