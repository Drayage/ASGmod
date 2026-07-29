import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const games = readArg("games", "4");
const moveMs = readArg("move-ms", "300");
const simulations = readArg("simulations", "10000");
const maxMoves = readArg("max-moves", "90");
const seed = readArg("seed", "20260729");

console.log(
  `Starting CURRENT vs HYBRID_MCTS arena: games=${games}, move-ms=${moveMs}, simulations=${simulations}, max-moves=${maxMoves}, seed=${seed}`,
);

const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const testFile = "src/games/alley-boss-cats/engine/mctsArena.test.ts";
const result = spawnSync(process.execPath, [vitest, "run", testFile, "--reporter=verbose"], {
  stdio: "inherit",
  env: {
    ...process.env,
    RUN_MCTS_ARENA: "1",
    ABC_ARENA_GAMES: games,
    ABC_ARENA_MOVE_MS: moveMs,
    ABC_ARENA_MCTS_SIMULATIONS: simulations,
    ABC_ARENA_MAX_MOVES: maxMoves,
    ABC_ARENA_SEED: seed,
  },
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
