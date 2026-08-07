/**
 * The four 2023-08-22 exhibition games, parsed from the published diagrams and
 * checked against this engine's own rules.
 *
 * Each diagram gives, per point, either the move number played there, a
 * territory mark, or nothing. That is enough to recover the whole game: invert
 * the numbers and you have the move order. The published move lists (partial
 * for one game, complete for the rest) agree with every number, and the
 * territory marks agree with the printed scores, so the transcription is
 * checked twice before this file does anything with it.
 *
 * The point of running them through `applyMove` is to find out whether these
 * are the same game at all. They are 9x9 with territory scoring, and nothing
 * about the diagrams says outright that a capture ends it. If every move is
 * legal here and the final territory comes out at the printed score, they are
 * — and 20 recorded games become 24, four of them by a far stronger player
 * than the rest.
 *
 *   npx vite-node pro-games.mts -- --write docs/pro-games-20230822.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { applyMove, createInitialState, isLegalMove } from "./src/games/alley-boss-cats/rules";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

function arg(name: string): string | null {
  const flag = process.argv.indexOf(`--${name}`);
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

interface Diagram {
  id: string;
  /** Plays first; the amateur in all four, since the professional took white. */
  firstPlayer: string;
  secondPlayer: string;
  /**
   * Printed territory, first player then second, or null where the diagram
   * was never marked up. Game two's score field reads 0/0 while its diagram
   * carries no territory marks at all — an unfilled field, not a game where
   * neither side held a point, which after 47 moves would be extraordinary
   * next to the 7/14, 12/14 and 11/12 of the other three.
   */
  score: { first: number; second: number } | null;
  /**
   * Nine rows of nine, top row first. A number is the move played there, `F`
   * is territory for the first player, `S` for the second, `.` is neither.
   */
  rows: string[][];
}

const split = (row: string): string[] => row.trim().split(/\s+/);

const DIAGRAMS: Diagram[] = [
  {
    id: "20230822-jongssam",
    firstPlayer: "종쌤",
    secondPlayer: "이세돌",
    score: { first: 7, second: 14 },
    rows: [
      "F  21 46 S  42 47 33 13 F",
      "F  45 2  44 43 31 6  35 F",
      "F  9  22 S  48 .  32 5  F",
      "25 24 S  S  S  8  S  34 49",
      ".  20 S  S  .  S  52 12 .",
      "50 S  S  30 .  18 51 10 11",
      ".  4  38 37 23 29 27 3  17",
      "19 .  1  39 40 7  26 15 14",
      "F  41 .  36 S  28 S  16 S",
    ].map(split),
  },
  {
    id: "20230822-leejeongsu",
    firstPlayer: "이정수",
    secondPlayer: "이세돌",
    score: null,
    rows: [
      ".  6  16 30 25 .  27 12 .",
      ".  .  5  26 10 13 9  20 .",
      ".  4  11 .  14 29 28 2  .",
      ".  .  43 7  47 15 .  17 18",
      ".  8  36 46 .  .  21 23 19",
      ".  .  45 37 44 .  .  22 .",
      ".  3  .  42 .  35 34 .  32",
      ".  .  38 .  40 .  1  24 31",
      ".  39 .  .  .  41 .  33 .",
    ].map(split),
  },
  {
    id: "20230822-leejunyoung",
    firstPlayer: "이준영",
    secondPlayer: "이세돌",
    score: { first: 12, second: 14 },
    rows: [
      "F  F  15 23 F  43 42 6  S",
      "F  21 20 12 7  F  1  46 S",
      "F  3  18 17 19 41 36 4  S",
      "35 .  22 16 .  5  47 48 S",
      "39 10 S  S  .  F  51 14 S",
      "40 S  32 30 37 F  33 34 50",
      "S  8  31 25 F  29 .  2  49",
      "S  S  38 24 9  F  11 44 13",
      "S  S  28 S  26 27 F  45 F",
    ].map(split),
  },
  {
    id: "20230822-jangwoncheol",
    firstPlayer: "장원철",
    secondPlayer: "이세돌",
    score: { first: 11, second: 12 },
    rows: [
      "S  28 48 49 F  F  47 14 S",
      "26 .  1  F  9  F  3  39 40",
      "27 36 .  25 .  41 44 6  S",
      "F  5  24 13 50 8  S  S  S",
      "37 .  20 23 .  S  S  38 S",
      "F  21 22 11 .  12 34 S  S",
      "F  7  16 18 15 .  33 4  30",
      "43 42 2  S  10 17 F  29 35",
      "F  31 45 46 32 .  19 F  F",
    ].map(split),
  },
];

const COLUMNS = "ABCDEFGHI";

interface Parsed {
  id: string;
  moves: Array<{ row: number; col: number }>;
  territory: { first: number; second: number };
}

function parse(diagram: Diagram): Parsed {
  if (diagram.rows.length !== 9) throw new Error(`${diagram.id}: ${diagram.rows.length} rows`);

  const byNumber = new Map<number, { row: number; col: number }>();
  const territory = { first: 0, second: 0 };

  diagram.rows.forEach((cells, row) => {
    if (cells.length !== 9) throw new Error(`${diagram.id}: row ${row + 1} has ${cells.length} cells`);
    cells.forEach((cell, col) => {
      if (cell === ".") return;
      if (cell === "F") return void (territory.first += 1);
      if (cell === "S") return void (territory.second += 1);
      const number = Number(cell);
      if (!Number.isInteger(number) || number < 1) throw new Error(`${diagram.id}: bad cell "${cell}"`);
      if (byNumber.has(number)) throw new Error(`${diagram.id}: move ${number} appears twice`);
      byNumber.set(number, { row, col });
    });
  });

  // Every move from 1 to the highest must be present: a gap would mean a
  // misread digit, and replaying past it would put the rest of the game on a
  // board that never existed.
  const total = Math.max(...byNumber.keys());
  const moves: Array<{ row: number; col: number }> = [];
  for (let number = 1; number <= total; number += 1) {
    const at = byNumber.get(number);
    if (!at) throw new Error(`${diagram.id}: move ${number} missing from the diagram`);
    moves.push(at);
  }

  if (
    diagram.score &&
    (territory.first !== diagram.score.first || territory.second !== diagram.score.second)
  ) {
    throw new Error(
      `${diagram.id}: diagram shows ${territory.first}/${territory.second} territory, ` +
        `printed score says ${diagram.score.first}/${diagram.score.second}`,
    );
  }

  return { id: diagram.id, moves, territory };
}

const notation = (move: { row: number; col: number }) => `${COLUMNS[move.col]}${move.row + 1}`;

let allValid = true;
const records: unknown[] = [];

for (const diagram of DIAGRAMS) {
  const parsed = parse(diagram);
  let state: GameState = createInitialState();
  let illegal: string | null = null;

  for (const [index, move] of parsed.moves.entries()) {
    if (state.winner) {
      illegal = `game already over at move ${index + 1}`;
      break;
    }
    if (!isLegalMove(state, move.row, move.col, state.currentPlayer)) {
      illegal = `move ${index + 1} (${notation(move)}) is illegal`;
      break;
    }
    state = applyMove(state, move.row, move.col);
  }

  // The first player is A here, so their territory is A's.
  const replayed = { first: state.territories.A.length, second: state.territories.B.length };
  // Only the marked-up diagrams can confirm the rules; the unmarked one is
  // checked for legality alone and takes its territory from the replay.
  const scoreMatches =
    diagram.score === null ||
    (replayed.first === parsed.territory.first && replayed.second === parsed.territory.second);
  const valid = illegal === null && scoreMatches;
  if (!valid) allValid = false;

  console.log(`${diagram.id}  (${diagram.firstPlayer} vs ${diagram.secondPlayer})`);
  console.log(`  ${parsed.moves.length} moves, all legal: ${illegal === null ? "yes" : `NO — ${illegal}`}`);
  console.log(
    diagram.score === null
      ? `  territory replayed ${replayed.first}/${replayed.second}; diagram not marked up, nothing to check against`
      : `  territory replayed ${replayed.first}/${replayed.second}, ` +
        `diagram ${parsed.territory.first}/${parsed.territory.second} — ${scoreMatches ? "match" : "MISMATCH"}`,
  );
  console.log(`  winner by this engine's rules: ${state.winner ?? "none"} (${state.winReason ?? "unfinished"})\n`);

  records.push({
    id: parsed.id,
    // The professional took the second seat in all four, so B is the strong
    // side and A the amateur. Recorded explicitly: the analysis scripts split
    // their columns on this and a guess would swap them.
    playerSide: "B" as Player,
    strongSide: "B" as Player,
    firstPlayer: diagram.firstPlayer,
    secondPlayer: diagram.secondPlayer,
    winner: state.winner ?? null,
    winReason: state.winReason ?? null,
    territoryA: replayed.first,
    territoryB: replayed.second,
    moveHistory: parsed.moves.map((move) => ({ type: "PLACE", row: move.row, col: move.col })),
  });
}

console.log(
  allValid
    ? "Every move legal, and every marked-up diagram scores exactly as printed — same rules as this engine."
    : "At least one game does not replay under these rules; do not use them as data.",
);

const out = arg("write");
if (out && allValid) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        format: "alley-boss-cats-games",
        version: 1,
        note:
          "2023-08-22 exhibition, 이세돌 playing four amateurs two boards at a time, " +
          "second seat in every game. Transcribed from the published diagrams and " +
          "verified: move numbering complete, every move legal under these rules, " +
          "final territory equal to the printed score. Validation only; never train on these.",
        records,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`wrote ${out}`);
}
