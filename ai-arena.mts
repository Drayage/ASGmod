/**
 * Plays the AI difficulties against each other and reports win rates.
 * Openings are randomized so deterministic engines don't replay one game.
 */
import { getAIMove, type AIAction, type Difficulty } from "./src/games/alley-boss-cats/ai";
import { findBestMoveMinimax, findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { wideAreaBotMove } from "./src/games/alley-boss-cats/engine/wideAreaBot";
import { sealingBotMove } from "./src/games/alley-boss-cats/engine/sealingBot";
import {
  applyMove,
  calculateFinalResult,
  createInitialState,
  getLegalMoves,
  passTurn,
} from "./src/games/alley-boss-cats/rules";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

type Engine = Difficulty | "RANDOM" | "WIDE" | "SEAL";

const HARD_MS = Number(process.env.HARD_MS ?? 250);
const VERY_HARD_MS = Number(process.env.VERY_HARD_MS ?? 1200);
const MAX_PLIES = 160;
const RANDOM_OPENING_PLIES = 4;

function decide(state: GameState, player: Player, engine: Engine): AIAction {
  if (engine === "RANDOM") {
    const moves = getLegalMoves(state, player);
    if (moves.length === 0) return { type: "PASS" };
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { type: "PLACE", row: pick.row, col: pick.col };
  }
  if (engine === "WIDE") return wideAreaBotMove(state, player);
  if (engine === "SEAL") return sealingBotMove(state, player);
  if (engine === "HARD") return findBestMoveMinimax(state, player, HARD_MS);
  if (engine === "VERY_HARD") return findBestMoveVeryHard(state, player, VERY_HARD_MS);
  return getAIMove(state, player, engine);
}

function act(state: GameState, action: AIAction): GameState {
  return action.type === "PASS" ? passTurn(state) : applyMove(state, action.row, action.col);
}

interface GameResult {
  winner: Player;
  reason: "CAPTURE" | "TERRITORY" | "PLY_CAP";
  plies: number;
  /** Ply on which each side first held any settled ground. The engine's real
   * weakness is here rather than in the win rate: against a human it settled
   * nothing until move 22-29 while they were converting by move 10, and lost
   * both long games because of it. Win rate over a dozen games is far too
   * noisy to steer on; this moves the moment something changes. */
  firstTerritory: Record<Player, number | null>;
  finalTerritory: Record<Player, number>;
}

function playGame(engineA: Engine, engineB: Engine): GameResult {
  let state = createInitialState();
  const firstTerritory: Record<Player, number | null> = { A: null, B: null };

  const noteTerritory = (ply: number) => {
    for (const side of ["A", "B"] as Player[]) {
      if (firstTerritory[side] === null && state.territories[side].length > 0) {
        firstTerritory[side] = ply;
      }
    }
  };

  // Randomized opening so deterministic engines produce distinct games.
  for (let i = 0; i < RANDOM_OPENING_PLIES; i++) {
    const moves = getLegalMoves(state, state.currentPlayer);
    if (moves.length === 0) break;
    const pick = moves[Math.floor(Math.random() * moves.length)];
    state = applyMove(state, pick.row, pick.col);
    noteTerritory(i + 1);
  }

  for (let ply = 0; ply < MAX_PLIES; ply++) {
    if (state.winner) {
      return {
        winner: state.winner,
        reason: state.winReason === "CAPTURE" ? "CAPTURE" : "TERRITORY",
        plies: ply,
        firstTerritory,
        finalTerritory: { A: state.territories.A.length, B: state.territories.B.length },
      };
    }
    const player = state.currentPlayer;
    const engine = player === "A" ? engineA : engineB;
    state = act(state, decide(state, player, engine));
    noteTerritory(ply + 1 + RANDOM_OPENING_PLIES);
  }

  return {
    winner: calculateFinalResult(state).winner,
    reason: "PLY_CAP",
    plies: MAX_PLIES,
    firstTerritory,
    finalTerritory: { A: state.territories.A.length, B: state.territories.B.length },
  };
}

function runMatch(label: string, engineX: Engine, engineY: Engine, games: number) {
  let xWins = 0;
  const reasons: Record<string, number> = {};
  let totalPlies = 0;
  const xFirst: number[] = [];
  const yFirst: number[] = [];
  let xTerritory = 0;
  let yTerritory = 0;

  for (let i = 0; i < games; i++) {
    // Alternate colors so the first-player advantage cancels out.
    const xIsA = i % 2 === 0;
    const result = playGame(xIsA ? engineX : engineY, xIsA ? engineY : engineX);
    const xWon = xIsA ? result.winner === "A" : result.winner === "B";
    if (xWon) xWins += 1;
    reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
    totalPlies += result.plies;

    const xSide: Player = xIsA ? "A" : "B";
    const ySide: Player = xIsA ? "B" : "A";
    if (result.firstTerritory[xSide] !== null) xFirst.push(result.firstTerritory[xSide]!);
    if (result.firstTerritory[ySide] !== null) yFirst.push(result.firstTerritory[ySide]!);
    xTerritory += result.finalTerritory[xSide];
    yTerritory += result.finalTerritory[ySide];
  }

  const mean = (xs: number[]) => (xs.length === 0 ? "-" : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1));

  const pct = Math.round((xWins / games) * 100);
  console.log(
    `${label}: ${xWins}/${games} (${pct}%)  | 종료사유 ${JSON.stringify(reasons)} | 평균 ${Math.round(totalPlies / games)}수\n` +
      `${" ".repeat(label.length)}  첫 확정 ${mean(xFirst)}수 (${xFirst.length}판) vs ${mean(yFirst)}수 (${yFirst.length}판)` +
      ` | 평균 최종영토 ${(xTerritory / games).toFixed(1)} : ${(yTerritory / games).toFixed(1)}`,
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
if (only === "VS_HARD") runMatch("VERY_HARD vs HARD  ", "VERY_HARD", "HARD", games);
if (only === "WIDE") {
  runMatch("VERY_HARD vs WIDE  ", "VERY_HARD", "WIDE", games);
  runMatch("HARD      vs WIDE  ", "HARD", "WIDE", games);
  runMatch("NORMAL    vs WIDE  ", "NORMAL", "WIDE", games);
}
if (only === "VS_SEAL") runMatch("VERY_HARD vs SEAL  ", "VERY_HARD", "SEAL", games);
if (only === "SEAL") {
  runMatch("VERY_HARD vs SEAL  ", "VERY_HARD", "SEAL", games);
  runMatch("HARD      vs SEAL  ", "HARD", "SEAL", games);
  runMatch("NORMAL    vs SEAL  ", "NORMAL", "SEAL", games);
}
if (only === "VS_NORMAL") runMatch("VERY_HARD vs NORMAL", "VERY_HARD", "NORMAL", games);
if (!only) runMatch("NORMAL vs EASY", "NORMAL", "EASY", games);
console.timeEnd("total");
