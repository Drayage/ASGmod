/**
 * Relabels positions with an averaged playout instead of a single game result.
 *
 * The pilot labels every position in a game with that game's one final margin.
 * Measured, roughly half of that number is not a property of an early position
 * at all: replaying one gives a spread of 3.02 cells against a total spread of
 * 4.22, capping any model's opening correlation near 0.70. The model reaches
 * 0.244, and training on eight times the games did not move it — which is what
 * noise-limited learning looks like.
 *
 * Averaging k playouts cuts that noise variance by k, so the ceiling goes from
 * 0.699 at k=1 to 0.934 at k=4. That is a bigger move than five times the data
 * buys, for comparable cost, and it is the point of this tool.
 *
 * It writes the same rows with both labels kept, so a model can be trained on
 * each and the two compared over identical positions — otherwise a difference
 * in score could just be a difference in which positions were seen.
 *
 *   npx vite-node averaged-labels.mts -- --input positions.jsonl \
 *     --out averaged.jsonl --games 60 --every 3 --playouts 4
 */
import { readFileSync, writeFileSync } from "node:fs";
import { averagedLabel } from "./src/games/alley-boss-cats/labelPlayout";
import { createInitialState } from "./src/games/alley-boss-cats/rules";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { BOARD_SIZE } from "./src/games/alley-boss-cats/types";
import type { Board, Cell, GameState } from "./src/games/alley-boss-cats/types";

function arg(name: string, fallback: string | null = null): string | null {
  const flag = process.argv.indexOf(`--${name}`);
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

function decodeBoard(encoded: string): Board {
  const board: Board = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const line: Cell[] = [];
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const character = encoded[row * BOARD_SIZE + col];
      line.push(
        character === "A"
          ? "PLAYER_A"
          : character === "B"
            ? "PLAYER_B"
            : character === "N"
              ? "NEUTRAL"
              : "EMPTY",
      );
    }
    board.push(line);
  }
  return board;
}

const inputPath = arg("input");
const outPath = arg("out");
if (!inputPath || !outPath) {
  throw new Error("usage: averaged-labels.mts -- --input <in.jsonl> --out <out.jsonl>");
}
const gameLimit = Number(arg("games", "60"));
const every = Number(arg("every", "3"));
const playouts = Number(arg("playouts", "4"));
const topK = Number(arg("top-k", "3"));
const shardCount = Number(arg("shard-count", "1"));
const shardIndex = Number(arg("shard-index", "0"));

interface Row {
  g: number;
  ply: number;
  board: string;
  own: string;
  margin: number;
  [key: string]: unknown;
}

const rows: Row[] = [];
for (const line of readFileSync(inputPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const parsed = JSON.parse(line) as Row;
  if (((parsed.sym as number) ?? 0) !== 0) continue;
  rows.push(parsed);
}

const games = [...new Set(rows.map((row) => row.g))].sort((a, b) => a - b).slice(0, gameLimit);
const keep = new Set(games);
// Thin within each game: neighbouring plies are nearly the same board, so
// labelling every one spends the playout budget on near-duplicates.
const perGamePly = new Map<number, number>();
const selected = rows.filter((row) => {
  if (!keep.has(row.g)) return false;
  const seen = perGamePly.get(row.g) ?? 0;
  perGamePly.set(row.g, seen + 1);
  return seen % every === 0;
});

const mine = selected.filter((_, index) => index % shardCount === shardIndex);
console.log(
  `${rows.length} rows -> ${selected.length} selected from ${games.length} games; ` +
    `shard ${shardIndex + 1}/${shardCount} takes ${mine.length}, ` +
    `${playouts} playouts each (top-${topK})`,
);

const out: string[] = [];
const started = Date.now();
for (const [index, row] of mine.entries()) {
  const board = decodeBoard(row.board);
  const base = createInitialState();
  const state: GameState = {
    ...base,
    board,
    territories: calculateTerritories(board),
    currentPlayer: row.ply % 2 === 0 ? "A" : "B",
  };
  const label = averagedLabel(state, 1_000_003 + row.g * 7919 + row.ply * 31, playouts, { topK });
  out.push(
    JSON.stringify({
      ...row,
      margin: Number(label.mean.toFixed(4)),
      marginSingleGame: row.margin,
      marginPlayoutSD: Number(label.standardDeviation.toFixed(4)),
      marginPlayouts: label.playouts,
    }),
  );
  if ((index + 1) % 50 === 0) {
    const rate = (Date.now() - started) / 1000 / (index + 1);
    const left = ((mine.length - index - 1) * rate) / 60;
    console.log(`  ${index + 1}/${mine.length}  ${rate.toFixed(2)}s each, ~${left.toFixed(1)}min left`);
  }
}

writeFileSync(outPath, out.join("\n") + "\n", "utf8");

const sds = out.map((line) => JSON.parse(line).marginPlayoutSD as number);
const meanSd = sds.reduce((sum, value) => sum + value, 0) / Math.max(1, sds.length);
console.log(
  `\nwrote ${out.length} rows to ${outPath}\n` +
    `mean within-position playout SD ${meanSd.toFixed(3)} cells; ` +
    `averaging ${playouts} cuts that to ${(meanSd / Math.sqrt(playouts)).toFixed(3)} on the label`,
);
