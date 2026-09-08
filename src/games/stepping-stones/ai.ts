import { countFlats, getAllLegalActions, playAction } from "./rules";
import { BOARD_SIZE, inBounds, opponent, topStone } from "./types";
import type { Action, GameState, Player } from "./types";

export type Difficulty = "EASY" | "NORMAL" | "HARD";

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  EASY: "쉬움",
  NORMAL: "보통",
  HARD: "어려움",
};

function randomChoice<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/** Size of `player`'s largest connected cluster of road-eligible stones
 * (flats and capstones) anywhere on the board — not necessarily touching
 * an edge yet, just a proxy for how close they are to a road: the bigger
 * their biggest cluster, the fewer new stones a road needs to finish it. */
function largestRoadCluster(state: GameState, player: Player): number {
  const owns = (row: number, col: number) => {
    const top = topStone(state.board[row][col]);
    return top !== null && top.owner === player && (top.kind === "FLAT" || top.kind === "CAP");
  };
  const seen = new Set<string>();
  let best = 0;
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const startKey = `${row},${col}`;
      if (!owns(row, col) || seen.has(startKey)) continue;
      let size = 0;
      const queue = [{ row, col }];
      seen.add(startKey);
      while (queue.length > 0) {
        const cell = queue.pop()!;
        size++;
        for (const [dr, dc] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const r = cell.row + dr;
          const c = cell.col + dc;
          const key = `${r},${c}`;
          if (inBounds(r, c) && owns(r, c) && !seen.has(key)) {
            seen.add(key);
            queue.push({ row: r, col: c });
          }
        }
      }
      best = Math.max(best, size);
    }
  }
  return best;
}

function evaluate(state: GameState, forPlayer: Player): number {
  if (state.winner === forPlayer) return Infinity;
  const rival = opponent(forPlayer);
  if (state.winner === rival) return -Infinity;
  if (state.winner === "DRAW") return 0;

  const flatDiff = countFlats(state, forPlayer) - countFlats(state, rival);
  const roadDiff = largestRoadCluster(state, forPlayer) - largestRoadCluster(state, rival) * 1.2;
  return flatDiff * 2 + roadDiff * 3;
}

function chooseEasyMove(state: GameState): Action {
  return randomChoice(getAllLegalActions(state));
}

function chooseGreedyMove(state: GameState): Action {
  const player = state.currentPlayer;
  const actions = getAllLegalActions(state);
  let best: Action[] = [];
  let bestScore = -Infinity;
  for (const action of actions) {
    const score = evaluate(playAction(state, action), player);
    if (score > bestScore) {
      bestScore = score;
      best = [action];
    } else if (score === bestScore) {
      best.push(action);
    }
  }
  return randomChoice(best);
}

export function getAIMove(state: GameState, difficulty: Difficulty): Action {
  switch (difficulty) {
    case "EASY":
      return chooseEasyMove(state);
    case "NORMAL":
    case "HARD":
      // HARD reuses the same one-ply "does this immediately look better"
      // evaluation as NORMAL — Stepping Stones' branching factor (every
      // carry/drop composition from every controlled stack, every turn)
      // makes a real multi-ply search too expensive to be worth it here,
      // same tradeoff as 꼭짓점 마을's HARD AI. The difference is scale:
      // HARD's road-cluster term dominates the score far more heavily, so
      // it plays more purposefully toward finishing a road instead of
      // just grabbing whatever nets the best flat count this instant.
      return difficulty === "HARD" ? chooseHardMove(state) : chooseGreedyMove(state);
  }
}

function chooseHardMove(state: GameState): Action {
  const player = state.currentPlayer;
  const rival = opponent(player);
  const actions = getAllLegalActions(state);
  let best: Action[] = [];
  let bestScore = -Infinity;
  for (const action of actions) {
    const after = playAction(state, action);
    let score = evaluate(after, player);
    if (score !== Infinity && score !== -Infinity) {
      const flatDiff = countFlats(after, player) - countFlats(after, rival);
      const roadDiff = largestRoadCluster(after, player) - largestRoadCluster(after, rival) * 1.2;
      score = flatDiff * 1.5 + roadDiff * 6;
    }
    if (score > bestScore) {
      bestScore = score;
      best = [action];
    } else if (score === bestScore) {
      best.push(action);
    }
  }
  return randomChoice(best);
}
