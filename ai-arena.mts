/**
 * Plays the AI difficulties against each other and reports win rates.
 * Openings are randomized so deterministic engines don't replay one game.
 */
import { getAIMove, type AIAction, type Difficulty } from "./src/games/alley-boss-cats/ai";
import { findBestMoveMinimax } from "./src/games/alley-boss-cats/engine/minimax";
import {
  applyMove,
  calculateFinalResult,
  createInitialState,
  getLegalMoves,
  passTurn,
} from "./src/games/alley-boss-cats/rules";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

type Engine = Difficulty | "RANDOM";

const HARD_MS = Number(process.env.HARD_MS ?? 250);
const MAX_PLIES = 160;
const RANDOM_OPENING_PLIES = 4;

function decide(state: GameState, player: Player, engine: Engine): AIAction {
  if (engine === "RANDOM") {
    const moves = getLegalMoves(state, player);
    if (moves.length === 0) return { type: "PASS" };
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { type: "PLACE", row: pick.row, col: pick.col };
  }
  if (engine === "HARD") return findBestMoveMinimax(state, player, HARD_MS);
  return getAIMove(state, player, engine);
}

function act(state: GameState, action: AIAction): GameState {
  return action.type === "PASS" ? passTurn(state) : applyMove(state, action.row, action.col);
}

interface GameResult {
  winner: Player;
  reason: "CAPTURE" | "TERRITORY" | "PLY_CAP";
  plies: number;
}

function playGame(engineA: Engine, engineB: Engine): GameResult {
  let state = createInitialState();

  // Randomized opening so deterministic engines produce distinct games.
  for (let i = 0; i < RANDOM_OPENING_PLIES; i++) {
    const moves = getLegalMoves(state, state.currentPlayer);
    if (moves.length === 0) break;
    const pick = moves[Math.floor(Math.random() * moves.length)];
    state = applyMove(state, pick.row, pick.col);
  }

  for (let ply = 0; ply < MAX_PLIES; ply++) {
    if (state.winner) {
      return {
        winner: state.winner,
        reason: state.winReason === "CAPTURE" ? "CAPTURE" : "TERRITORY",
        plies: ply,
      };
    }
    const player = state.currentPlayer;
    const engine = player === "A" ? engineA : engineB;
    state = act(state, decide(state, player, engine));
  }

  return { winner: calculateFinalResult(state).winner, reason: "PLY_CAP", plies: MAX_PLIES };
}

function runMatch(label: string, engineX: Engine, engineY: Engine, games: number) {
  let xWins = 0;
  const reasons: Record<string, number> = {};
  let totalPlies = 0;

  for (let i = 0; i < games; i++) {
    // Alternate colors so the first-player advantage cancels out.
    const xIsA = i % 2 === 0;
    const result = playGame(xIsA ? engineX : engineY, xIsA ? engineY : engineX);
    const xWon = xIsA ? result.winner === "A" : result.winner === "B";
    if (xWon) xWins += 1;
    reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
    totalPlies += result.plies;
  }

  const pct = Math.round((xWins / games) * 100);
  console.log(
    `${label}: ${xWins}/${games} (${pct}%)  | 종료사유 ${JSON.stringify(reasons)} | 평균 ${Math.round(totalPlies / games)}수`,
  );
  return xWins;
}

const games = Number(process.env.GAMES ?? 12);
console.log(`HARD 탐색시간 ${HARD_MS}ms, 게임당 최대 ${MAX_PLIES}수, 매치당 ${games}판\n`);

const only = process.env.ONLY;

console.time("total");
if (!only || only === "RANDOM") runMatch("HARD vs RANDOM", "HARD", "RANDOM", games);
if (!only || only === "EASY") runMatch("HARD vs EASY  ", "HARD", "EASY", games);
if (!only || only === "NORMAL") runMatch("HARD vs NORMAL", "HARD", "NORMAL", games);
if (!only) runMatch("NORMAL vs EASY", "NORMAL", "EASY", games);
console.timeEnd("total");
