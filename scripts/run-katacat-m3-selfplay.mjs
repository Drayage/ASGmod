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
const checkpoint = args.checkpoint ?? args["bootstrap-checkpoint"];
if (!checkpoint) {
  console.error("--checkpoint=<M1 checkpoint path> is required");
  process.exit(2);
}

const env = {
  ...process.env,
  RUN_KATACAT_M3_SELFPLAY: "1",
  KATACAT_M3_BOOTSTRAP_CHECKPOINT: checkpoint,
  KATACAT_M3_OUTPUT_DIR: args.output ?? "katacat-m3-output",
  KATACAT_M3_GAMES: args.games ?? "4",
  KATACAT_M3_SIMULATIONS: args.simulations ?? "64",
  KATACAT_M3_MAX_MOVES: args["max-moves"] ?? "90",
  KATACAT_M3_TEMPERATURE_MOVES: args["temperature-moves"] ?? "12",
  KATACAT_M3_SEED: args.seed ?? "20260730",
  KATACAT_M3_CPUCT: args.cpuct ?? "1.35",
  KATACAT_M3_NEURAL_PRIOR_WEIGHT: args["neural-prior-weight"] ?? "0.75",
  KATACAT_M3_SCORE_VALUE_WEIGHT: args["score-value-weight"] ?? "0.05",
  KATACAT_M3_NOISE_ALPHA: args["noise-alpha"] ?? "0.3",
  KATACAT_M3_NOISE_FRACTION: args["noise-fraction"] ?? "0.25",
};

console.log(
  `Generating KataCat M3 self-play: games=${env.KATACAT_M3_GAMES}, simulations=${env.KATACAT_M3_SIMULATIONS}, checkpoint=${checkpoint}`,
);

const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  executable,
  [
    "vitest",
    "run",
    "src/games/alley-boss-cats/engine/katacatM3Selfplay.test.ts",
  ],
  { env, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
