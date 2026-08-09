/**
 * Does the idle move actually cost anything?
 *
 * From turn 31 the engine puts 45% of its stones inside a room it already
 * dominates with no enemy stone beside them, where the human puts 8%. That is a
 * difference in behaviour; whether it is a defect is a separate question, and
 * the last five changes in this branch were built on skipping it.
 *
 * A stone in your own ground costs one cell of it outright. The claim worth
 * testing is bigger: that it also costs the move — the opponent gets a free turn
 * to reduce. So this measures, for every move from turn 21 on, how the mover's
 * total dominated empty space changes from just before their move to just after
 * the reply, and splits that by whether the move touched an enemy stone.
 *
 * Both arms come from the same side, the same games, and the same turn bands, so
 * the comparison is within a player rather than between them.
 *
 * Unstratified it says idle moves cost 4.6 cells against 1.7 for the engine —
 * and 7.9 against 1.1 for the human, who barely plays them. That is the
 * confound, not the finding: you can only play inside a large room if you have
 * one, and large rooms shrink fastest. So the comparison is made inside bands of
 * how much space the mover held before moving, where both arms start level.
 *
 *   npx vite-node idle-cost.mts <export.json ...>
 */
import { readFileSync } from "node:fs";
import { applyAction } from "./src/games/alley-boss-cats/ai";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { BOARD_SIZE, DIRECTIONS, inBounds, opponent, playerCell } from "./src/games/alley-boss-cats/types";
import type { Board, Coord, GameState, Player } from "./src/games/alley-boss-cats/types";

const ONLY = process.env.ONLY_REASON ?? "TERRITORY";
const FROM_TURN = Number(process.env.FROM_TURN ?? 21);
const BIG_ROOM = Number(process.env.BIG_ROOM ?? 6);

/** Every empty cell sitting in a room this side walls more of than the other. */
function dominatedCells(board: Board, side: Player): number {
  const mine = playerCell(side);
  const theirs = playerCell(opponent(side));
  const seen = new Set<string>();
  let total = 0;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (board[row][col] !== "EMPTY" || seen.has(`${row},${col}`)) continue;
      const stack = [{ row, col }];
      seen.add(`${row},${col}`);
      let size = 0, ours = 0, enemy = 0;
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
      if (ours > enemy) total += size;
    }
  }
  return total;
}

function roomAt(board: Board, at: Coord, side: Player) {
  const mine = playerCell(side);
  const theirs = playerCell(opponent(side));
  const seen = new Set([`${at.row},${at.col}`]);
  const stack = [at];
  let size = 0, ours = 0, enemy = 0;
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

/** Bands of the mover's dominated space before the move. */
const HELD = [0, 10, 20, 30, 45] as const;
const heldBand = (n: number) => {
  for (let i = HELD.length - 1; i >= 0; i -= 1) if (n >= HELD[i]) return i;
  return 0;
};
const heldLabel = (i: number) =>
  i === HELD.length - 1 ? `${HELD[i]}+` : `${HELD[i]}-${HELD[i + 1] - 1}`;

type Arm = number[][];
const blankArm = (): Arm => HELD.map(() => []);
const arms: Record<string, Record<string, Arm>> = {
  human: { idle: blankArm(), other: blankArm() },
  ai: { idle: blankArm(), other: blankArm() },
};

const seen = new Set<string>();
let games = 0;
for (const path of process.argv.slice(2)) {
  for (const rec of (JSON.parse(readFileSync(path, "utf8")) as { records: any[] }).records) {
    if (rec.id && seen.has(rec.id)) continue;
    if (rec.id) seen.add(rec.id);
    if (ONLY && rec.winReason !== ONLY) continue;
    games += 1;
    const humanSide: Player = rec.playerSide;

    // Replay once, keeping every position so a move can look one reply ahead.
    const states: GameState[] = [createInitialState()];
    for (const m of rec.moveHistory) {
      const cur = states[states.length - 1];
      if (cur.winner) break;
      states.push(
        m.type === "PASS"
          ? applyAction(cur, { type: "PASS" })
          : applyAction(cur, { type: "PLACE", row: m.row!, col: m.col! }),
      );
    }

    for (let i = 0; i + 2 < states.length; i += 1) {
      const turn = i + 1;
      if (turn < FROM_TURN) continue;
      const move = rec.moveHistory[i];
      if (!move || move.type !== "PLACE") continue;
      const before = states[i];
      const mover = before.currentPlayer;
      // The reply must actually be the opponent's, not a second move by us.
      const afterReply = states[i + 2];

      const r = roomAt(before.board, { row: move.row, col: move.col }, mover);
      const enemy = playerCell(opponent(mover));
      let touchesEnemy = false;
      for (const [dr, dc] of DIRECTIONS) {
        const rr = move.row + dr, cc = move.col + dc;
        if (inBounds(rr, cc) && before.board[rr][cc] === enemy) { touchesEnemy = true; break; }
      }
      const idle = r.dominated && r.size >= BIG_ROOM && !touchesEnemy;

      const held = dominatedCells(before.board, mover);
      const delta = dominatedCells(afterReply.board, mover) - held;
      arms[mover === humanSide ? "human" : "ai"][idle ? "idle" : "other"][heldBand(held)].push(delta);
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
console.log(
  `change in the mover's dominated empty space, from before their move to after the reply\n` +
    `turns ${FROM_TURN}+, ${games} games decided by the count\n`,
);
console.log(
  `${"".padEnd(16)}${HELD.map((_, i) => heldLabel(i).padStart(16)).join("")}` +
    `\n${"side / move".padEnd(16)}${HELD.map(() => "mean (n)".padStart(16)).join("")}`,
);
for (const [name, byKind] of Object.entries(arms)) {
  for (const kind of ["idle", "other"]) {
    console.log(
      `${`${name} ${kind}`.padEnd(16)}` +
        byKind[kind]
          .map((xs) => (xs.length ? `${mean(xs).toFixed(1)} (${xs.length})` : "-").padStart(16))
          .join(""),
    );
  }
}
console.log(`\nidle minus other, within each band:`);
for (const name of ["human", "ai"]) {
  console.log(
    `${name.padEnd(16)}` +
      arms[name].idle
        .map((xs, i) => {
          const other = arms[name].other[i];
          if (xs.length < 5 || other.length < 5) return "-".padStart(16);
          const d = mean(xs) - mean(other);
          const se = Math.sqrt(sd(xs) ** 2 / xs.length + sd(other) ** 2 / other.length);
          return `${d.toFixed(1)} +/- ${(1.96 * se).toFixed(1)}`.padStart(16);
        })
        .join(""),
  );
}
