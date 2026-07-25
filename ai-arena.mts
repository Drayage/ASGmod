/**
 * Plays the AI difficulties against each other and reports win rates.
 * Openings are randomized so deterministic engines don't replay one game.
 */
import { getAIMove, getSafeActions, tuning, type AIAction, type Difficulty } from "./src/games/alley-boss-cats/ai";
import { findBestMoveMinimax, findBestMoveVeryHard } from "./src/games/alley-boss-cats/engine/minimax";
import { wideAreaBotMove } from "./src/games/alley-boss-cats/engine/wideAreaBot";
import { sealingBotMove } from "./src/games/alley-boss-cats/engine/sealingBot";
import {
  applyMove,
  calculateFinalResult,
  createInitialState,
  getLegalMoves,
  isLegalMove,
  passTurn,
} from "./src/games/alley-boss-cats/rules";
import type { GameState, Player } from "./src/games/alley-boss-cats/types";

type Engine = Difficulty | "RANDOM" | "WIDE" | "SEAL" | "VH_FRAME";

/** Framework weight given to the VH_FRAME variant. Everything else about it is
 * identical to VERY_HARD, so a head-to-head measures that one term and nothing
 * else — the scripted bots lose on tactics long before area decides anything,
 * which makes them useless for this question. */
const FRAME_W = Number(process.env.FRAME_W ?? 60);

const HARD_MS = Number(process.env.HARD_MS ?? 250);
const VERY_HARD_MS = Number(process.env.VERY_HARD_MS ?? 1200);
const MAX_PLIES = 160;
/**
 * Opening plies played before the engines take over, so deterministic engines
 * do not replay one game.
 *
 * These are drawn from a short list of sensible opening points rather than from
 * anywhere on the board, and that distinction turned out to matter more than
 * anything else being measured. Picking uniformly at random dropped scattered,
 * weak cats that seeded capture races: games ran 19-22 moves and 72 of 72
 * finished in a capture with not one decided on territory. Removing the random
 * opening entirely fixed that — 41-move games, territory decisions appearing —
 * but left the engines deterministic, so twenty "games" were two games replayed
 * ten times each.
 *
 * Sensible points give both: real variety, and openings that do not hand either
 * side a weakness before the engines have played a move.
 */
const RANDOM_OPENING_PLIES = Number(process.env.OPENING_PLIES ?? 4);

/** Third-line and star points — where a player opens when staking out corners
 * rather than dropping cats at random. */
const OPENING_POINTS: ReadonlyArray<[number, number]> = [
  [2, 2], [2, 6], [6, 2], [6, 6],
  [2, 4], [4, 2], [4, 6], [6, 4],
  [3, 3], [3, 5], [5, 3], [5, 5],
  [2, 3], [3, 2], [5, 6], [6, 5],
];

function decide(state: GameState, player: Player, engine: Engine): AIAction {
  // Set before every decision, so the two engines keep their own weight even
  // though they share the module. Search is synchronous, so this is safe.
  tuning.frameworkWeight = engine === "VH_FRAME" ? FRAME_W : 0;

  if (engine === "RANDOM") {
    const moves = getLegalMoves(state, player);
    if (moves.length === 0) return { type: "PASS" };
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { type: "PLACE", row: pick.row, col: pick.col };
  }
  if (engine === "WIDE") return wideAreaBotMove(state, player);
  if (engine === "SEAL") return sealingBotMove(state, player);
  if (engine === "HARD") return findBestMoveMinimax(state, player, HARD_MS);
  if (engine === "VERY_HARD" || engine === "VH_FRAME") return findBestMoveVeryHard(state, player, VERY_HARD_MS);
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
  /**
   * Safe moves each side still had at a fixed point in the middlegame.
   *
   * This is the quantity the game actually turns on. Capture ends almost every
   * game, but a capture is what happens when a player runs out of moves that do
   * not lose something — and what takes those moves away is the opponent's
   * territory, which nobody may play into, and their living walls. Squeezing
   * that number is the pressure; the capture is the symptom. Two engines that
   * apply no pressure to each other simply shuffle safely until one of them
   * runs out late, which is what every measurement here had been picking up.
   */
  safeMovesAt: Record<Player, number | null>;
}

/** Ply at which the squeeze is sampled — deep enough to be past the opening,
 * early enough that most games are still running. */
const PRESSURE_PLY = 20;

function playGame(engineA: Engine, engineB: Engine): GameResult {
  let state = createInitialState();
  const firstTerritory: Record<Player, number | null> = { A: null, B: null };
  const safeMovesAt: Record<Player, number | null> = { A: null, B: null };

  const noteTerritory = (ply: number) => {
    for (const side of ["A", "B"] as Player[]) {
      if (firstTerritory[side] === null && state.territories[side].length > 0) {
        firstTerritory[side] = ply;
      }
    }
  };

  // Randomized opening so deterministic engines produce distinct games.
  const openings = [...OPENING_POINTS].sort(() => Math.random() - 0.5);
  for (let i = 0, taken = 0; i < openings.length && taken < RANDOM_OPENING_PLIES; i++) {
    const [row, col] = openings[i];
    if (!isLegalMove(state, row, col, state.currentPlayer)) continue;
    state = applyMove(state, row, col);
    taken += 1;
    noteTerritory(taken);
  }

  for (let ply = 0; ply < MAX_PLIES; ply++) {
    if (state.winner) {
      return {
        winner: state.winner,
        reason: state.winReason === "CAPTURE" ? "CAPTURE" : "TERRITORY",
        plies: ply,
        firstTerritory,
        finalTerritory: { A: state.territories.A.length, B: state.territories.B.length },
        safeMovesAt,
      };
    }
    const player = state.currentPlayer;
    if (ply + RANDOM_OPENING_PLIES === PRESSURE_PLY) {
      safeMovesAt.A = getSafeActions(state, "A").pool.length;
      safeMovesAt.B = getSafeActions(state, "B").pool.length;
    }
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
    safeMovesAt,
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
  const xSafe: number[] = [];
  const ySafe: number[] = [];

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
    if (result.safeMovesAt[xSide] !== null) xSafe.push(result.safeMovesAt[xSide]!);
    if (result.safeMovesAt[ySide] !== null) ySafe.push(result.safeMovesAt[ySide]!);
  }

  const mean = (xs: number[]) => (xs.length === 0 ? "-" : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1));

  const pct = Math.round((xWins / games) * 100);
  console.log(
    `${label}: ${xWins}/${games} (${pct}%)  | 종료사유 ${JSON.stringify(reasons)} | 평균 ${Math.round(totalPlies / games)}수\n` +
      `${" ".repeat(label.length)}  첫 확정 ${mean(xFirst)}수 (${xFirst.length}판) vs ${mean(yFirst)}수 (${yFirst.length}판)` +
      ` | 평균 최종영토 ${(xTerritory / games).toFixed(1)} : ${(yTerritory / games).toFixed(1)}\n` +
      `${" ".repeat(label.length)}  ${PRESSURE_PLY}수째 상대에게 남은 안전한 수 ${mean(ySafe)} (내가 압박) vs ${mean(xSafe)} (상대가 압박)`,
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
if (only === "AB") runMatch(`VH+프레임(${FRAME_W}) vs VERY_HARD`, "VH_FRAME", "VERY_HARD", games);
if (only === "VS_SEAL") runMatch("VERY_HARD vs SEAL  ", "VERY_HARD", "SEAL", games);
if (only === "SEAL") {
  runMatch("VERY_HARD vs SEAL  ", "VERY_HARD", "SEAL", games);
  runMatch("HARD      vs SEAL  ", "HARD", "SEAL", games);
  runMatch("NORMAL    vs SEAL  ", "NORMAL", "SEAL", games);
}
if (only === "VS_NORMAL") runMatch("VERY_HARD vs NORMAL", "VERY_HARD", "NORMAL", games);
if (!only) runMatch("NORMAL vs EASY", "NORMAL", "EASY", games);
console.timeEnd("total");
