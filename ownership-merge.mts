/**
 * Recombines sharded ownership-dataset runs.
 *
 * Baseline rates are pooled from the raw counts each shard reports, never by
 * averaging the shards' percentages — a short shard and a long one would
 * otherwise carry equal weight, and the pooled precision would be wrong in a
 * way nothing downstream would catch.
 *
 *   npx vite-node ownership-merge.mts -- --out merged.json shard0.json shard1.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { rounded } from "./arena-aggregate";

interface BaselineReport {
  positionsScored: number;
  allCells: number;
  allCorrect: number;
  openCells: number;
  openCorrect: number;
  claimedOpenCells: number;
  heldOpenCells: number;
  claimedAndHeldOpenCells: number;
  [key: string]: unknown;
}

interface ShardSummary {
  config: Record<string, unknown>;
  dataset: Record<string, unknown>;
  baselines: Record<string, BaselineReport>;
  humanValidation: { baselines: Record<string, BaselineReport> } | null;
  [key: string]: unknown;
}

const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
if (outIndex === -1 || !argv[outIndex + 1]) {
  throw new Error("usage: ownership-merge.mts --out <merged.json> <shard.json>...");
}
const outPath = argv[outIndex + 1];
const shardPaths = argv.filter((value, index) => {
  if (index === outIndex || index === outIndex + 1) return false;
  return !value.startsWith("--");
});
if (shardPaths.length === 0) throw new Error("no shard summaries given");

const shards: ShardSummary[] = shardPaths.map(
  (path) => JSON.parse(readFileSync(path, "utf8")) as ShardSummary,
);

const IDENTITY_KEYS = ["games", "moveMs", "maxPlies", "captureMode", "seed", "openingPlies"] as const;
const [first, ...rest] = shards;
for (const [index, shard] of rest.entries()) {
  for (const key of IDENTITY_KEYS) {
    const a = JSON.stringify(first.config[key]);
    const b = JSON.stringify(shard.config[key]);
    if (a !== b) {
      throw new Error(
        `shard ${shardPaths[index + 1]} disagrees on ${key}: ${a} vs ${b} — ` +
          `these are different runs, not shards of one`,
      );
    }
  }
}

function poolBaselines(
  sets: Array<Record<string, BaselineReport>>,
): Record<string, BaselineReport> {
  const names = new Set<string>();
  for (const set of sets) for (const name of Object.keys(set)) names.add(name);

  const pooled: Record<string, BaselineReport> = {};
  for (const name of names) {
    const parts = sets.map((set) => set[name]).filter(Boolean);
    const sum = (pick: (report: BaselineReport) => number) =>
      parts.reduce((total, report) => total + (pick(report) ?? 0), 0);

    const allCells = sum((r) => r.allCells);
    const allCorrect = sum((r) => r.allCorrect);
    const openCells = sum((r) => r.openCells);
    const openCorrect = sum((r) => r.openCorrect);
    const claimed = sum((r) => r.claimedOpenCells);
    const held = sum((r) => r.heldOpenCells);
    const hit = sum((r) => r.claimedAndHeldOpenCells);

    pooled[name] = {
      positionsScored: sum((r) => r.positionsScored),
      allCells,
      allCorrect,
      openCells,
      openCorrect,
      claimedOpenCells: claimed,
      heldOpenCells: held,
      claimedAndHeldOpenCells: hit,
      allCellsPercent: allCells === 0 ? null : rounded((allCorrect / allCells) * 100),
      openCellsPercent: openCells === 0 ? null : rounded((openCorrect / openCells) * 100),
      territoryRecallPercent: held === 0 ? null : rounded((hit / held) * 100),
      territoryPrecisionPercent: claimed === 0 ? null : rounded((hit / claimed) * 100),
    };
  }
  return pooled;
}

const numeric = (key: string) =>
  shards.reduce((total, shard) => total + Number(shard.dataset[key] ?? 0), 0);

const finishReasons: Record<string, number> = {};
for (const shard of shards) {
  const reasons = (shard.dataset.finishReasons ?? {}) as Record<string, number>;
  for (const [reason, count] of Object.entries(reasons)) {
    finishReasons[reason] = (finishReasons[reason] ?? 0) + count;
  }
}

const labelTotals = shards.reduce(
  (totals, shard) => {
    const dist = shard.dataset.labelDistribution as Record<string, number>;
    totals.A += dist.A;
    totals.B += dist.B;
    totals.nobody += dist.nobody;
    return totals;
  },
  { A: 0, B: 0, nobody: 0 },
);
const labelCells = labelTotals.A + labelTotals.B + labelTotals.nobody;

const output = {
  ...first,
  generatedAt: new Date().toISOString(),
  mergedFromShards: shardPaths.length,
  config: { ...first.config, shardCount: shardPaths.length, shardIndex: null },
  dataset: {
    ...first.dataset,
    gamesGenerated: numeric("gamesGenerated"),
    positions: numeric("positions"),
    rowsWritten: numeric("rowsWritten"),
    rowsAfterEightfoldSymmetry: numeric("rowsAfterEightfoldSymmetry"),
    trainPositions: numeric("trainPositions"),
    valPositions: numeric("valPositions"),
    completionsCappedOut: numeric("completionsCappedOut"),
    declinedCaptureWins: numeric("declinedCaptureWins"),
    finishReasons,
    labelDistribution: {
      ...labelTotals,
      aPercent: labelCells === 0 ? null : rounded((labelTotals.A / labelCells) * 100),
      bPercent: labelCells === 0 ? null : rounded((labelTotals.B / labelCells) * 100),
      nobodyPercent: labelCells === 0 ? null : rounded((labelTotals.nobody / labelCells) * 100),
    },
    // These are per-shard distributions that do not pool by addition; the shard
    // files keep them, and re-deriving them here would mean re-reading every row.
    playedPlies: null,
    completionPliesAdded: null,
    finalMarginFromA: null,
  },
  baselines: poolBaselines(shards.map((shard) => shard.baselines)),
  humanValidation: first.humanValidation
    ? {
        ...first.humanValidation,
        // Every shard scores the same 20 human games, so the pooled set is one
        // shard's, not the sum of all of them.
        baselines: first.humanValidation.baselines,
      }
    : null,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(
  `merged ${shardPaths.length} shards: ${output.dataset.gamesGenerated} games, ` +
    `${output.dataset.rowsWritten} rows ` +
    `(${output.dataset.rowsAfterEightfoldSymmetry} after eightfold symmetry)`,
);
console.log(`finish reasons ${JSON.stringify(finishReasons)}`);
console.log("\nbaseline ownership accuracy (open points — the number a model must beat):");
for (const [name, report] of Object.entries(output.baselines)) {
  console.log(
    `  ${name.padEnd(18)} open ${String(report.openCellsPercent).padStart(9)}%   ` +
      `recall ${String(report.territoryRecallPercent).padStart(9)}%   ` +
      `precision ${String(report.territoryPrecisionPercent).padStart(9)}%`,
  );
}
console.log(`\nwrote ${outPath}`);
