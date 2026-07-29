import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const games = readArg("games", "12");
const teacherMs = readArg("teacher-ms", "300");
const maxMoves = readArg("max-moves", "56");
const warmupMoves = readArg("warmup-moves", "8");
const sampleEvery = readArg("sample-every", "2");
const seed = readArg("seed", "20260729");
const output = resolve(readArg("output", "ownership-dataset.jsonl"));
const metadataOutput = output.endsWith(".jsonl")
  ? output.slice(0, -".jsonl".length) + ".meta.json"
  : `${output}.meta.json`;

console.log(
  `Generating ownership dataset: games=${games}, teacher-ms=${teacherMs}, max-moves=${maxMoves}, warmup=${warmupMoves}, sample-every=${sampleEvery}, seed=${seed}`,
);

const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const testFile = "src/games/alley-boss-cats/engine/ownershipDataset.test.ts";
const result = spawnSync(process.execPath, [vitest, "run", testFile, "--reporter=verbose", "--no-color"], {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  env: {
    ...process.env,
    NO_COLOR: "1",
    RUN_OWNERSHIP_DATASET: "1",
    ABC_DATASET_GAMES: games,
    ABC_DATASET_TEACHER_MS: teacherMs,
    ABC_DATASET_MAX_MOVES: maxMoves,
    ABC_DATASET_WARMUP_MOVES: warmupMoves,
    ABC_DATASET_SAMPLE_EVERY: sampleEvery,
    ABC_DATASET_SEED: seed,
  },
});

if (result.error) throw result.error;
if (result.stderr) process.stderr.write(result.stderr);

const stdout = result.stdout ?? "";
const prefix = "OWNERSHIP_DATASET_JSON:";
const markerIndex = stdout.indexOf(prefix);
if (markerIndex < 0) {
  process.stdout.write(stdout);
  throw new Error("Dataset marker was not produced. Check the Vitest output above.");
}

const beforeMarker = stdout.slice(0, markerIndex);
const payloadLine = stdout.slice(markerIndex + prefix.length).split(/\r?\n/, 1)[0];
process.stdout.write(beforeMarker);

const payload = JSON.parse(payloadLine);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, payload.samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
writeFileSync(metadataOutput, JSON.stringify(payload.metadata, null, 2) + "\n");

console.log(`Saved ${payload.samples.length} samples to ${output}`);
console.log(`Saved dataset metadata to ${metadataOutput}`);
console.log(
  `Teacher overrides: ${payload.metadata.teacherOverrides}/${payload.metadata.samples}; final territory cells: ${payload.metadata.finalTerritoryCells}`,
);

process.exit(result.status ?? 1);
