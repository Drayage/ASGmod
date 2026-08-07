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
  /** Which output file the game belongs to. */
  set: "pro" | "community";
  /** What each seat was, for the role-split analyses. */
  firstRole: "pro" | "amateur";
  secondRole: "pro" | "amateur";
  /** Anything about the record that a later reader must not have to rediscover. */
  caveat?: string;
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
    set: "pro",
    firstRole: "amateur",
    secondRole: "pro",
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
    set: "pro",
    firstRole: "amateur",
    secondRole: "pro",
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
    set: "pro",
    firstRole: "amateur",
    secondRole: "pro",
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
    id: "20230605-proyeonwoo",
    set: "pro",
    firstRole: "amateur",
    secondRole: "pro",
    firstPlayer: "프로연우",
    secondPlayer: "이세돌",
    score: { first: 7, second: 11 },
    rows: [
      "S  26 59 41 57 32 S  S  S",
      "12 58 1  F  9  17 8  18 14",
      "54 11 F  45 F  21 15 13 61",
      "56 55 31 44 25 20 29 62 53",
      "S  10 42 S  .  S  30 6  60",
      "38 37 35 40 S  22 28 S  34",
      "S  2  43 36 52 46 27 4  33",
      "24 23 7  39 19 47 3  48 5",
      "S  16 50 51 F  F  F  49 F",
    ].map(split),
  },
  {
    id: "20230822-jangwoncheol",
    set: "pro",
    firstRole: "amateur",
    secondRole: "pro",
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
  {
    id: "20230718-practice6",
    set: "community",
    firstRole: "amateur",
    secondRole: "amateur",
    firstPlayer: "레이지니",
    secondPlayer: "종쌤",
    score: null,
    rows: [
      ".  42 .  19 44 .  .  14 .",
      "7  43 3  18 16 17 13 30 .",
      "39 2  21 22 .  .  .  12 .",
      "40 .  32 20 .  15 31 27 28",
      ".  6  .  .  .  .  .  .  29",
      ".  36 35 34 .  11 .  .  .",
      "41 4  33 26 38 .  25 9  .",
      "5  .  1  37 .  23 8  24 10",
      ".  .  .  .  .  .  .  .  .",
    ].map(split),
  },
  {
    id: "20230718-practice7",
    set: "community",
    firstRole: "amateur",
    secondRole: "amateur",
    firstPlayer: "종쌤",
    secondPlayer: "레이지니",
    score: null,
    rows: [
      ".  .  .  .  .  .  .  7  .",
      ".  .  .  .  10 .  4  .  .",
      ".  2  .  .  .  .  .  5  .",
      ".  .  .  .  .  .  .  .  .",
      ".  .  .  .  .  .  .  .  .",
      ".  .  .  11 .  .  .  .  .",
      ".  1  18 .  .  .  .  6  .",
      "13 19 .  14 9  .  3  .  .",
      ".  12 16 15 .  17 .  8  .",
    ].map(split),
  },
  {
    id: "20230709-practice5",
    set: "community",
    firstRole: "amateur",
    secondRole: "amateur",
    firstPlayer: "종쌤",
    secondPlayer: "레이지니",
    score: { first: 18, second: 13 },
    rows: [
      ".  26 S  S  S  S  S  S  S",
      "25 40 8  S  S  S  2  42 6",
      "27 4  39 38 S  22 41 5  32",
      "29 28 37 24 44 23 F  F  43",
      "21 .  17 35 .  F  F  7  F",
      "F  9  .  14 45 15 F  F  F",
      "F  F  19 36 .  16 33 3  F",
      "F  F  1  20 12 S  10 30 31",
      "F  F  F  13 18 S  34 11 F",
    ].map(split),
  },
  {
    id: "20230709-practice4",
    set: "community",
    firstRole: "amateur",
    secondRole: "amateur",
    firstPlayer: "레이지니",
    secondPlayer: "종쌤",
    caveat:
      "the diagram misses one point. I5 and I6 are a single enclosed empty " +
      "region — I5's only empty neighbour is I6 and vice versa — and every " +
      "stone around them was played on an odd move (5, 27, 29, 31), so all " +
      "four belong to the first player and both points are theirs. The " +
      "diagram marks I6 and leaves I5 blank, which no scoring rule allows for " +
      "two points of one region. 16/8 is the corrected count.",
    score: { first: 16, second: 8 },
    rows: [
      "F  F  F  17 .  16 .  12 S",
      "F  F  1  22 14 15 11 50 S",
      "F  9  24 S  18 .  .  10 30",
      "23 F  49 20 .  13 19 33 29",
      "F  F  21 .  .  47 32 5  F",
      "F  F  37 38 S  48 26 27 F",
      "F  7  36 44 8  S  28 3  31",
      "35 34 6  41 42 S  2  39 4",
      "F  25 43 F  45 46 S  40 S",
    ].map(split),
  },
  {
    id: "20230705-practice3",
    set: "community",
    firstRole: "amateur",
    secondRole: "amateur",
    firstPlayer: "레이지니",
    secondPlayer: "종쌤",
    score: null,
    rows: [
      ".  .  .  .  .  .  .  10 .",
      ".  .  29 .  11 .  9  .  .",
      "26 .  23 28 .  .  .  2  .",
      ".  14 21 22 .  43 .  .  .",
      "24 15 16 42 .  .  .  6  .",
      "25 17 18 27 31 8  38 .  .",
      "19 12 20 30 7  37 .  4  .",
      "13 40 3  34 36 39 1  32 5",
      ".  41 .  35 .  .  .  33 .",
    ].map(split),
  },
  {
    id: "20230705-practice2",
    set: "community",
    firstRole: "amateur",
    secondRole: "amateur",
    firstPlayer: "종쌤",
    secondPlayer: "레이지니",
    score: { first: 11, second: 8 },
    rows: [
      "51 16 55 29 37 36 24 S  S",
      "17 54 18 9  F  23 2  S  S",
      "F  3  20 56 21 60 46 4  S",
      "13 57 22 19 F  49 45 47 48",
      "53 8  S  32 .  58 35 12 S",
      "27 28 26 14 59 44 33 34 S",
      "61 6  25 40 15 42 52 10 50",
      "7  30 1  41 F  43 5  38 11",
      "F  31 F  F  F  F  F  39 F",
    ].map(split),
  },
  {
    id: "20230705-practice1",
    set: "community",
    firstRole: "amateur",
    secondRole: "amateur",
    firstPlayer: "레이지니",
    secondPlayer: "종쌤",
    score: { first: 3, second: 3 },
    rows: [
      "F  11 F  31 .  .  .  .  .",
      "9  10 7  30 .  .  2  .  4",
      ".  8  12 .  .  .  .  3  .",
      ".  .  .  32 .  6  .  .  .",
      "28 19 23 33 .  S  40 5  .",
      "S  24 14 25 .  34 39 F  41",
      "26 13 42 27 37 35 36 1  .",
      "22 43 15 29 18 38 16 .  .",
      "S  20 .  21 .  .  .  17 .",
    ].map(split),
  },
  {
    id: "20230605-pro-vs-pro",
    set: "community",
    firstRole: "pro",
    secondRole: "pro",
    firstPlayer: "김노경 프로",
    secondPlayer: "조연우 프로",
    caveat: "the source marks moves 39-52 as being of uncertain order",
    score: { first: 10, second: 10 },
    rows: [
      "S  S  30 S  S  S  S  42 .",
      "40 26 27 38 S  32 10 46 37",
      "39 28 11 .  52 9  45 8  43",
      "F  29 25 24 S  44 47 31 F",
      "F  23 22 S  .  .  7  F  F",
      "F  15 13 16 S  48 49 5  F",
      "41 12 14 18 50 1  3  4  51",
      "54 20 19 17 34 36 2  6  33",
      ".  21 F  F  35 .  .  53 F",
    ].map(split),
  },
  {
    id: "20230527-koreaboardgames",
    set: "community",
    firstRole: "amateur",
    secondRole: "pro",
    firstPlayer: "레이지니",
    secondPlayer: "이세돌",
    caveat: "played with 이세돌 coaching, so it is not straight competitive play",
    score: { first: 11, second: 17 },
    rows: [
      "S  S  S  38 S  S  S  40 50",
      "S  S  4  3  36 34 6  48 39",
      "S  2  46 5  37 13 51 10 41",
      "S  S  S  22 35 F  7  33 F",
      "S  8  12 S  .  F  F  F  F",
      "32 52 11 14 21 F  45 F  F",
      "S  16 17 15 49 23 44 9  43",
      "28 27 1  47 24 25 18 19 42",
      "31 F  F  29 30 26 S  20 S",
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
    strongSide:
      diagram.firstRole === diagram.secondRole
        ? undefined
        : ((diagram.secondRole === "pro" ? "B" : "A") as Player),
    firstPlayer: diagram.firstPlayer,
    secondPlayer: diagram.secondPlayer,
    firstRole: diagram.firstRole,
    secondRole: diagram.secondRole,
    caveat: diagram.caveat,
    set: diagram.set,
    winner: state.winner ?? null,
    winReason: state.winReason ?? null,
    territoryA: replayed.first,
    territoryB: replayed.second,
    // The source scored four of the five. Game two's diagram carries no
    // territory marks and its score field reads 0/0 while the replay gives
    // 3/4, so its endpoint is not confirmed by anything and no conversion
    // rate should be quoted from it. Its moves are verified either way.
    territoryVerified: diagram.score !== null,
    moveHistory: parsed.moves.map((move) => ({ type: "PLACE", row: move.row, col: move.col })),
  });
}

console.log(
  allValid
    ? "Every move legal, and every marked-up diagram scores exactly as printed — same rules as this engine."
    : "At least one game does not replay under these rules; do not use them as data.",
);

const FILES: Record<Diagram["set"], { path: string; note: string }> = {
  pro: {
    path: "docs/pro-games-20230822.json",
    note:
      "이세돌 exhibition games, second seat in every one. Transcribed from the " +
      "published diagrams and verified against these rules.",
  },
  community: {
    path: "docs/community-games.json",
    note:
      "Recorded games between other players — amateur practice games, one " +
      "professional pairing, and one coached game. Same transcription and " +
      "verification as the exhibition set.",
  },
};

// A bare `--write` has no value for `arg` to return, so presence is what is
// checked here rather than a value that would always come back null.
if (process.argv.includes("--write") && allValid) {
  for (const [set, file] of Object.entries(FILES)) {
    const mine = records.filter((record) => (record as { set: string }).set === set);
    if (mine.length === 0) continue;
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(
      file.path,
      `${JSON.stringify(
        {
          format: "alley-boss-cats-games",
          version: 1,
          note: `${file.note} Validation and seeding only; never train on these.`,
          records: mine,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`wrote ${file.path} (${mine.length} games)`);
  }
}
