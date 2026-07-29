import { describe, expect, it } from "vitest";
import { applyAction } from "../ai";
import type { AIAction } from "../ai";
import { createInitialState } from "../rules";
import { FIRST_PLAYER_MARGIN } from "../types";
import type { GameState, Player, WinReason } from "../types";
import { findBestMoveHybridMCTS } from "./mcts";
import { findBestMoveVeryHard } from "./minimax";

type EngineName = "CURRENT" | "HYBRID_MCTS";

interface TimingTotals {
  moves: number;
  elapsedMs: number;
  simulations: number;
}

interface ArenaTotals {
  wins: Record<EngineName, number>;
  captureWins: Record<EngineName, number>;
  territoryWins: Record<EngineName, number>;
  timing: Record<EngineName, TimingTotals>;
  territoryGames: number;
  mctsTerritoryMarginTotal: number;
}

interface ArenaMoveLog {
  turn: number;
  player: Player;
  engine: EngineName;
  action: AIAction;
  elapsedMs: number;
  simulations: number;
}

interface ArenaGameLog {
  game: number;
  seed: number;
  sides: Record<Player, EngineName>;
  winner: Player;
  winnerEngine: EngineName;
  winReason: Exclude<WinReason, null>;
  territory: Record<Player, number>;
  moves: ArenaMoveLog[];
}

interface ProcessLike {
  env?: Record<string, string | undefined>;
}

const env = (globalThis as typeof globalThis & { process?: ProcessLike }).process?.env ?? {};
const runArena = env.RUN_MCTS_ARENA === "1";
const arenaDescribe = runArena ? describe : describe.skip;

function envInt(name: string, fallback: number, minimum: number): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

const GAMES = env.ABC_ARENA_GAMES ? envInt("ABC_ARENA_GAMES", 4, 2) : 4;
const MOVE_BUDGET_MS = envInt("ABC_ARENA_MOVE_MS", 300, 20);
const MCTS_SIMULATIONS = envInt("ABC_ARENA_MCTS_SIMULATIONS", 10_000, 1);
const MAX_MOVES = envInt("ABC_ARENA_MAX_MOVES", 90, 10);
const BASE_SEED = envInt("ABC_ARENA_SEED", 20260729, 1);

function territoryMarginFor(state: GameState, player: Player): number {
  const rawLead = state.territories.A.length - state.territories.B.length;
  return player === "A" ? rawLead - FIRST_PLAYER_MARGIN : FIRST_PLAYER_MARGIN - rawLead;
}

function pickMove(
  engine: EngineName,
  state: GameState,
  player: Player,
  seed: number,
): { action: AIAction; elapsedMs: number; simulations: number } {
  const startedAt = Date.now();
  if (engine === "CURRENT") {
    const action = findBestMoveVeryHard(state, player, MOVE_BUDGET_MS);
    return { action, elapsedMs: Date.now() - startedAt, simulations: 0 };
  }

  const result = findBestMoveHybridMCTS(state, player, {
    timeLimitMs: MOVE_BUDGET_MS,
    simulations: MCTS_SIMULATIONS,
    seed,
    playoutDepth: 8,
    rootScreenLimit: 8,
  });
  return {
    action: result.action,
    elapsedMs: Date.now() - startedAt,
    simulations: result.simulations,
  };
}

function finishByTerritory(state: GameState): GameState {
  let current = state;
  for (let i = 0; i < 2 && !current.winner; i += 1) {
    current = applyAction(current, { type: "PASS" });
  }
  return current;
}

function playGame(
  gameIndex: number,
  totals: ArenaTotals,
): { state: GameState; sides: Record<Player, EngineName>; pairSeed: number; moves: ArenaMoveLog[] } {
  const mctsIsA = gameIndex % 2 === 0;
  const pairSeed = BASE_SEED + Math.floor(gameIndex / 2);
  const sides: Record<Player, EngineName> = mctsIsA
    ? { A: "HYBRID_MCTS", B: "CURRENT" }
    : { A: "CURRENT", B: "HYBRID_MCTS" };

  const moves: ArenaMoveLog[] = [];
  let state = createInitialState();
  while (!state.winner && state.moveHistory.length < MAX_MOVES) {
    const player = state.currentPlayer;
    const engine = sides[player];
    const moveSeed = pairSeed * 131 + state.moveHistory.length * 17 + (player === "A" ? 1 : 2);
    const picked = pickMove(engine, state, player, moveSeed);

    totals.timing[engine].moves += 1;
    totals.timing[engine].elapsedMs += picked.elapsedMs;
    totals.timing[engine].simulations += picked.simulations;
    moves.push({
      turn: state.moveHistory.length + 1,
      player,
      engine,
      action: picked.action,
      elapsedMs: picked.elapsedMs,
      simulations: picked.simulations,
    });
    state = applyAction(state, picked.action);
  }

  if (!state.winner) state = finishByTerritory(state);
  if (!state.winner) throw new Error(`Game ${gameIndex + 1} did not finish`);
  return { state, sides, pairSeed, moves };
}

function average(total: number, count: number): string {
  return count === 0 ? "-" : (total / count).toFixed(1);
}

arenaDescribe("CURRENT VERY_HARD vs HYBRID_MCTS arena", () => {
  it(
    "plays mirrored headless matches and prints a comparison",
    () => {
      const totals: ArenaTotals = {
        wins: { CURRENT: 0, HYBRID_MCTS: 0 },
        captureWins: { CURRENT: 0, HYBRID_MCTS: 0 },
        territoryWins: { CURRENT: 0, HYBRID_MCTS: 0 },
        timing: {
          CURRENT: { moves: 0, elapsedMs: 0, simulations: 0 },
          HYBRID_MCTS: { moves: 0, elapsedMs: 0, simulations: 0 },
        },
        territoryGames: 0,
        mctsTerritoryMarginTotal: 0,
      };
      const gameLogs: ArenaGameLog[] = [];

      console.log(
        `\nArena: ${GAMES} games, ${MOVE_BUDGET_MS}ms/move, MCTS max ${MCTS_SIMULATIONS} simulations, max ${MAX_MOVES} moves`,
      );

      for (let gameIndex = 0; gameIndex < GAMES; gameIndex += 1) {
        const { state, sides, pairSeed, moves } = playGame(gameIndex, totals);
        const winner = state.winner as Player;
        const winnerEngine = sides[winner];
        const winReason = state.winReason as Exclude<WinReason, null>;
        totals.wins[winnerEngine] += 1;
        if (winReason === "CAPTURE") totals.captureWins[winnerEngine] += 1;
        else totals.territoryWins[winnerEngine] += 1;

        const mctsPlayer: Player = sides.A === "HYBRID_MCTS" ? "A" : "B";
        if (winReason === "TERRITORY") {
          totals.territoryGames += 1;
          totals.mctsTerritoryMarginTotal += territoryMarginFor(state, mctsPlayer);
        }

        gameLogs.push({
          game: gameIndex + 1,
          seed: pairSeed,
          sides,
          winner,
          winnerEngine,
          winReason,
          territory: { A: state.territories.A.length, B: state.territories.B.length },
          moves,
        });

        console.log(
          `${gameIndex + 1}/${GAMES} seed=${pairSeed} | A=${sides.A}, B=${sides.B} | winner=${winnerEngine}(${winner}) ${winReason} | territory ${state.territories.A.length}:${state.territories.B.length} | moves=${state.moveHistory.length}`,
        );
      }

      const current = totals.timing.CURRENT;
      const mcts = totals.timing.HYBRID_MCTS;
      console.log("\n=== Arena result ===");
      console.log(`CURRENT wins: ${totals.wins.CURRENT}/${GAMES} (capture ${totals.captureWins.CURRENT}, territory ${totals.territoryWins.CURRENT})`);
      console.log(`MCTS wins:    ${totals.wins.HYBRID_MCTS}/${GAMES} (capture ${totals.captureWins.HYBRID_MCTS}, territory ${totals.territoryWins.HYBRID_MCTS})`);
      console.log(`CURRENT avg move: ${average(current.elapsedMs, current.moves)}ms`);
      console.log(`MCTS avg move:    ${average(mcts.elapsedMs, mcts.moves)}ms`);
      console.log(`MCTS avg simulations/move: ${average(mcts.simulations, mcts.moves)}`);
      console.log(`MCTS avg territory margin: ${average(totals.mctsTerritoryMarginTotal, totals.territoryGames)} (${totals.territoryGames} territory games)`);

      // The wrapper script removes this machine-readable line from the visible
      // log and saves it as mcts-arena.json for replay and regression tests.
      console.log(
        `ARENA_JSON:${JSON.stringify({
          config: {
            games: GAMES,
            moveBudgetMs: MOVE_BUDGET_MS,
            mctsSimulations: MCTS_SIMULATIONS,
            maxMoves: MAX_MOVES,
            baseSeed: BASE_SEED,
          },
          totals,
          games: gameLogs,
        })}`,
      );

      expect(totals.wins.CURRENT + totals.wins.HYBRID_MCTS).toBe(GAMES);
    },
    3_600_000,
  );
});
