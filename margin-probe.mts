/**
 * Is there any learnable signal about the final count in an early position?
 *
 * `margin-headroom.mts` measures what the engine's own signals are worth and
 * finds the answer collapses in the opening: correlation with the final margin
 * is 0.02 before ply 20, against 0.84 after ply 40. The engine is effectively
 * blind to territory in exactly the phase where these games are decided.
 *
 * Two very different things could explain that, and they call for opposite
 * plans:
 *
 *   - the signal is poor, and a better one would see what is coming; or
 *   - the final count is genuinely not yet determined that early, in which case
 *     no model recovers it and the engine should be playing for options rather
 *     than for a predicted total.
 *
 * A ridge regression on the raw board separates them, far more cheaply than
 * training anything. It is only linear and cannot see shape, so it is a floor,
 * not a ceiling: whatever it finds, a real model should find more. Finding
 * nothing is the informative outcome — that would say the phase is not
 * predictable rather than merely badly measured.
 *
 *   npx vite-node margin-probe.mts -- --input positions.jsonl
 */
import { readFileSync } from "node:fs";
import { BOARD_SIZE } from "./src/games/alley-boss-cats/types";

const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
/** One indicator per side per point, plus an intercept. */
const FEATURES = CELL_COUNT * 2 + 1;

function arg(name: string, fallback: string | null = null): string | null {
  const flag = process.argv.indexOf(`--${name}`);
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

interface Row {
  game: number;
  ply: number;
  features: Float64Array;
  target: number;
}

const inputPath = arg("input");
if (!inputPath) throw new Error("usage: margin-probe.mts -- --input <positions.jsonl>");
const lambda = Number(arg("lambda", "10"));

const rows: Row[] = [];
for (const line of readFileSync(inputPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const parsed = JSON.parse(line);
  // Base positions only: the eight symmetries of one board are one measurement.
  if ((parsed.symmetry ?? parsed.sym ?? 0) !== 0) continue;
  const board: string = parsed.board;
  const target: number = parsed.margin ?? parsed.finalMargin;
  const features = new Float64Array(FEATURES);
  for (let index = 0; index < CELL_COUNT; index += 1) {
    if (board[index] === "A") features[index] = 1;
    else if (board[index] === "B") features[CELL_COUNT + index] = 1;
  }
  features[FEATURES - 1] = 1;
  rows.push({ game: parsed.g ?? parsed.gameIndex ?? 0, ply: parsed.ply ?? 0, features, target });
}

// Split whole games. Positions inside one game share a label and are near
// duplicates of each other, so splitting within a game leaks the answer.
const games = [...new Set(rows.map((row) => row.game))].sort((a, b) => a - b);
const heldOut = new Set(games.filter((_, index) => index % 5 === 0));
const train = rows.filter((row) => !heldOut.has(row.game));
const test = rows.filter((row) => heldOut.has(row.game));

console.log(
  `${rows.length} positions, ${games.length} games — ` +
    `train ${train.length} / held-out ${test.length} (${heldOut.size} games)\n`,
);

/** Ridge regression by normal equations: (XᵀX + λI)w = Xᵀy. */
function fit(samples: Row[]): Float64Array {
  const xtx = new Float64Array(FEATURES * FEATURES);
  const xty = new Float64Array(FEATURES);
  for (const sample of samples) {
    const f = sample.features;
    // Only the set indicators contribute, and a board carries at most 81 of
    // them, so walking the non-zeros keeps this near-linear in the sample count.
    const active: number[] = [];
    for (let index = 0; index < FEATURES; index += 1) if (f[index] !== 0) active.push(index);
    for (const i of active) {
      xty[i] += sample.target;
      for (const j of active) xtx[i * FEATURES + j] += 1;
    }
  }
  for (let index = 0; index < FEATURES; index += 1) xtx[index * FEATURES + index] += lambda;

  // Gaussian elimination with partial pivoting.
  const a = Array.from({ length: FEATURES }, (_, i) =>
    Float64Array.from(xtx.subarray(i * FEATURES, (i + 1) * FEATURES)),
  );
  const b = Float64Array.from(xty);
  for (let col = 0; col < FEATURES; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < FEATURES; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    const diag = a[col][col];
    if (Math.abs(diag) < 1e-12) continue;
    for (let row = col + 1; row < FEATURES; row += 1) {
      const factor = a[row][col] / diag;
      if (factor === 0) continue;
      for (let k = col; k < FEATURES; k += 1) a[row][k] -= factor * a[col][k];
      b[row] -= factor * b[col];
    }
  }
  const w = new Float64Array(FEATURES);
  for (let row = FEATURES - 1; row >= 0; row -= 1) {
    let sum = b[row];
    for (let col = row + 1; col < FEATURES; col += 1) sum -= a[row][col] * w[col];
    w[row] = Math.abs(a[row][row]) < 1e-12 ? 0 : sum / a[row][row];
  }
  return w;
}

const predict = (w: Float64Array, f: Float64Array) => {
  let sum = 0;
  for (let index = 0; index < FEATURES; index += 1) if (f[index] !== 0) sum += w[index] * f[index];
  return sum;
};

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
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

const round = (value: number) => Number(value.toFixed(3));

const PHASES: Array<[string, (ply: number) => boolean]> = [
  ["opening   ply < 20", (ply) => ply < 20],
  ["middle 20 <= ply < 40", (ply) => ply >= 20 && ply < 40],
  ["endgame   ply >= 40", (ply) => ply >= 40],
];

console.log(`${"phase".padEnd(24)}${"n".padStart(6)}${"corr".padStart(8)}${"MAE".padStart(8)}${"vs even".padStart(10)}`);

// One model per phase. A single model over the whole game would be dominated by
// endgame positions, where the answer is nearly settled and easy — exactly the
// phase the engine already handles.
for (const [label, inPhase] of PHASES) {
  const phaseTrain = train.filter((row) => inPhase(row.ply));
  const phaseTest = test.filter((row) => inPhase(row.ply));
  if (phaseTrain.length < FEATURES || phaseTest.length === 0) {
    console.log(`${label.padEnd(24)}${String(phaseTest.length).padStart(6)}  too few samples`);
    continue;
  }
  const w = fit(phaseTrain);
  const predicted = phaseTest.map((row) => predict(w, row.features));
  const actual = phaseTest.map((row) => row.target);
  const corr = correlation(predicted, actual);
  const mae = predicted.reduce((sum, p, i) => sum + Math.abs(p - actual[i]), 0) / predicted.length;
  // Predicting the training mean every time — what "no signal" scores.
  const mean = phaseTrain.reduce((sum, row) => sum + row.target, 0) / phaseTrain.length;
  const evenMae = actual.reduce((sum, value) => sum + Math.abs(mean - value), 0) / actual.length;
  console.log(
    `${label.padEnd(24)}${String(phaseTest.length).padStart(6)}` +
      `${String(corr === null ? "—" : round(corr)).padStart(8)}${String(round(mae)).padStart(8)}` +
      `${String(round(evenMae)).padStart(10)}`,
  );
}
