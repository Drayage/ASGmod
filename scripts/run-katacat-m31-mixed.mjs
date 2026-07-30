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
const latest = args.latest ?? args["latest-checkpoint"];
const champion = args.champion ?? args["champion-checkpoint"];
if (!latest || !champion) {
  console.error("--latest=<M3 checkpoint> and --champion=<previous checkpoint> are required");
  process.exit(2);
}

const env = {
  ...process.env,
  RUN_KATACAT_M31_MIXED: "1",
  KATACAT_M31_LATEST_CHECKPOINT: latest,
  KATACAT_M31_CHAMPION_CHECKPOINT: champion,
  KATACAT_M31_OUTPUT_DIR: args.output ?? "katacat-m31-output",
  KATACAT_M31_GAMES: args.games ?? "5",
  KATACAT_M31_SIMULATIONS: args.simulations ?? "48",
  KATACAT_M31_CURRENT_MS: args["current-ms"] ?? "50",
  KATACAT_M31_MAX_MOVES: args["max-moves"] ?? "90",
  KATACAT_M31_SEED: args.seed ?? "20260730",
  KATACAT_M31_CAPTURE_DEPTH: args["capture-depth"] ?? "7",
  KATACAT_M31_CAPTURE_ATTACK_MS: args["capture-attack-ms"] ?? "25",
  KATACAT_M31_CAPTURE_DEFENSE_MS: args["capture-defense-ms"] ?? "50",
  KATACAT_M31_CAPTURE_DEFENSE_LIMIT: args["capture-defense-limit"] ?? "12",
  KATACAT_M31_VALIDATION_MODULO: args["validation-modulo"] ?? "5",
  KATACAT_M31_VALIDATION_OFFSET: args["validation-offset"] ?? "0",
};

console.log(
  `Generating KataCat M3.1 mixed data: games=${env.KATACAT_M31_GAMES}, simulations=${env.KATACAT_M31_SIMULATIONS}, validation=${env.KATACAT_M31_VALIDATION_OFFSET} mod ${env.KATACAT_M31_VALIDATION_MODULO}, latest=${latest}, champion=${champion}`,
);

const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  executable,
  ["vitest", "run", "src/games/alley-boss-cats/engine/katacatM31Mixed.test.ts"],
  { env, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
