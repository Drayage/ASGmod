/**
 * How well do the signals the evaluation already has predict the final count?
 *
 * The learned term this project is heading towards does not classify points; it
 * feeds `evaluateState` a number standing in for "how far ahead am I on ground".
 * So the question that decides whether a model is worth training is not how many
 * points it labels correctly — it is how closely a predicted margin tracks the
 * margin the game actually finishes on.
 *
 * That is measurable today, with no model, against the ownership dataset's
 * labels. This reports it for every signal the engine already computes, which
 * gives both the bar to beat and the headroom above it.
 *
 *   npx vite-node margin-headroom.mts -- --input positions.jsonl
 *
 * Reads the base (unaugmented) JSONL the ownership generator writes. Rows need
 * `board` and the final margin; both the current and previous generators supply
 * them, under `margin` or `finalMargin`.
 */
import { readFileSync } from "node:fs";
import { influenceCount } from "./src/games/alley-boss-cats/engine/territoryPlanner";
import { calculateTerritories } from "./src/games/alley-boss-cats/territory";
import { BOARD_SIZE } from "./src/games/alley-boss-cats/types";
import type { Board, Cell } from "./src/games/alley-boss-cats/types";
import { summarize } from "./arena-aggregate";

/** The weight the shipped evaluation puts on a cell of open ground. */
const INFLUENCE_TO_TERRITORY = 0.12;

function arg(name: string, fallback: string | null = null): string | null {
  const prefix = `--${name}=`;
  const flag = process.argv.indexOf(`--${name}`);
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
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

interface Row {
  board: string;
  margin: number;
  ply: number;
}

const inputPath = arg("input");
if (!inputPath) throw new Error("usage: margin-headroom.mts -- --input <positions.jsonl>");

const rows: Row[] = readFileSync(inputPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => {
    const parsed = JSON.parse(line);
    const board = parsed.board;
    const margin = parsed.margin ?? parsed.finalMargin;
    if (typeof board !== "string" || typeof margin !== "number") {
      throw new Error(`row lacks board/margin: ${line.slice(0, 120)}`);
    }
    // Only the unaugmented rows: the eight symmetries of one position are the
    // same measurement eight times and would pretend to eight times the sample.
    return { board, margin, ply: parsed.ply ?? 0, sym: parsed.symmetry ?? parsed.sym ?? 0 };
  })
  .filter((row) => (row as { sym: number }).sym === 0);

console.log(`${rows.length} positions from ${inputPath}\n`);

/** Signals that each produce a predicted final margin, from A's side. */
const PREDICTORS = {
  /** What `projectedMargin` uses today: settled ground plus timid influence. */
  shippedProjectedMargin: (board: Board) => {
    const territories = calculateTerritories(board);
    const influence = influenceCount(board);
    const settled = territories.A.length - territories.B.length;
    return settled + (influence.A - influence.B) * INFLUENCE_TO_TERRITORY;
  },
  /** Influence alone, unweighted — reach treated as if it were territory. */
  rawInfluenceMargin: (board: Board) => {
    const influence = influenceCount(board);
    return influence.A - influence.B;
  },
  /** Ground already walled in, and nothing speculative. */
  settledTerritoryMargin: (board: Board) => {
    const territories = calculateTerritories(board);
    return territories.A.length - territories.B.length;
  },
  /** Predict a dead heat every time. The floor any signal must beat. */
  alwaysEven: () => 0,
} as const;

type PredictorName = keyof typeof PREDICTORS;

const errors: Record<PredictorName, number[]> = {
  shippedProjectedMargin: [],
  rawInfluenceMargin: [],
  settledTerritoryMargin: [],
  alwaysEven: [],
};
const predictions: Record<PredictorName, number[]> = {
  shippedProjectedMargin: [],
  rawInfluenceMargin: [],
  settledTerritoryMargin: [],
  alwaysEven: [],
};
const actuals: number[] = [];

for (const row of rows) {
  const board = decodeBoard(row.board);
  actuals.push(row.margin);
  for (const name of Object.keys(PREDICTORS) as PredictorName[]) {
    const predicted = PREDICTORS[name](board);
    predictions[name].push(predicted);
    errors[name].push(predicted - row.margin);
  }
}

function correlation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

const round = (value: number) => Number(value.toFixed(3));
const actualSummary = summarize(actuals);
console.log(
  `actual final margin: mean ${actualSummary.mean}, SD ${actualSummary.standardDeviation}\n`,
);

console.log(
  `${"signal".padEnd(24)}${"MAE".padStart(8)}${"RMSE".padStart(9)}${"corr".padStart(8)}` +
    `${"bias".padStart(9)}`,
);
for (const name of Object.keys(PREDICTORS) as PredictorName[]) {
  const e = errors[name];
  const mae = e.reduce((sum, value) => sum + Math.abs(value), 0) / e.length;
  const rmse = Math.sqrt(e.reduce((sum, value) => sum + value * value, 0) / e.length);
  const bias = e.reduce((sum, value) => sum + value, 0) / e.length;
  const corr = correlation(predictions[name], actuals);
  console.log(
    `${name.padEnd(24)}${String(round(mae)).padStart(8)}${String(round(rmse)).padStart(9)}` +
      `${String(corr === null ? "—" : round(corr)).padStart(8)}${String(round(bias)).padStart(9)}`,
  );
}

// Where in the game the signal is worth anything. An evaluation term that only
// works once the count is nearly decided cannot steer the opening, which is
// where these games are being lost.
console.log("\nby phase (correlation with the final margin):");
const buckets: Array<[string, (ply: number) => boolean]> = [
  ["opening   ply < 20", (ply) => ply < 20],
  ["middle 20 <= ply < 40", (ply) => ply >= 20 && ply < 40],
  ["endgame   ply >= 40", (ply) => ply >= 40],
];
for (const [label, inBucket] of buckets) {
  const indices = rows.map((row, index) => ({ row, index })).filter(({ row }) => inBucket(row.ply));
  if (indices.length === 0) continue;
  const parts = (Object.keys(PREDICTORS) as PredictorName[]).map((name) => {
    const corr = correlation(
      indices.map(({ index }) => predictions[name][index]),
      indices.map(({ index }) => actuals[index]),
    );
    return `${name.replace("Margin", "")} ${corr === null ? "—" : round(corr)}`;
  });
  console.log(`  ${label.padEnd(24)} n=${String(indices.length).padStart(5)}  ${parts.join("  ")}`);
}
