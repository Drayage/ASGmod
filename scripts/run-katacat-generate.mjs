import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, ...rest] = argument.slice(2).split("=");
    values[key] = rest.join("=");
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const env = {
  ...process.env,
  RUN_KATACAT_GENERATE: "1",
  KATACAT_OUTPUT_DIR: args.output ?? args["output-dir"] ?? "katacat-m0-output",
  KATACAT_GAMES: args.games ?? "20",
  KATACAT_TEACHER_MS: args["teacher-ms"] ?? "100",
  KATACAT_MAX_MOVES: args["max-moves"] ?? "90",
  KATACAT_SEED: args.seed ?? "20260729",
  KATACAT_MAX_SAMPLES_PER_BUCKET: args["max-per-bucket"] ?? "16",
  KATACAT_NOISY_RATE: args["noisy-rate"] ?? "0.25",
  KATACAT_TERRITORY_PASS_PLY: args["territory-pass-ply"] ?? "56",
};

console.log(
  `Generating KataCat M0: games=${env.KATACAT_GAMES}, teacher-ms=${env.KATACAT_TEACHER_MS}, output=${env.KATACAT_OUTPUT_DIR}`,
);

const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  executable,
  [
    "vitest",
    "run",
    "src/games/alley-boss-cats/engine/katacatGenerate.test.ts",
  ],
  { env, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
