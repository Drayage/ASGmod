import { getAIMove } from "../ai";
import { getLegalMovesFrom, playMove } from "../rules";
import { cellOwner } from "../types";
import type { Action, Coord, GameState, Player } from "../types";
import type { StartConfig } from "./ModeSelect";
import { renderBoard } from "./BoardView";
import { renderResultPanel } from "./ResultModal";

const PLAYER_NAME: Record<Player, string> = { A: "장미 정원사", B: "수국 정원사" };
const AI_THINK_DELAY_MS = 350;
/** How long the "just converted" flash stays on a cell. Longer than the CSS
 * animation itself (0.5s) so the animation always finishes before the class
 * is removed. Cleared by a timer rather than the next click, because
 * `render()` rebuilds the board from scratch on every call — a selection
 * click, the AI's "thinking" render, anything — and a fresh DOM node replays
 * its animation the moment the class lands on it, so the class has to stop
 * being applied on its own instead of waiting for the player to do something. */
const CONVERTED_FLASH_MS = 650;

function countFlowers(state: GameState): Record<Player, number> {
  const counts: Record<Player, number> = { A: 0, B: 0 };
  for (const row of state.board) {
    for (const cell of row) {
      const owner = cellOwner(cell);
      if (owner) counts[owner] += 1;
    }
  }
  return counts;
}

/** Cells whose owner flipped to `mover` between two boards, landing cell
 * excluded — that one is a placement, not a conversion. */
function convertedCells(before: GameState, after: GameState, mover: Player, landing: Coord): Set<string> {
  const converted = new Set<string>();
  const size = after.board.length;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (row === landing.row && col === landing.col) continue;
      if (before.board[row][col] === after.board[row][col]) continue;
      if (cellOwner(after.board[row][col]) === mover) converted.add(`${row},${col}`);
    }
  }
  return converted;
}

function lastMoveOf(state: GameState): Coord | null {
  const last = state.moveHistory[state.moveHistory.length - 1];
  return last ? { row: last.row, col: last.col } : null;
}

export function mountGameScreen(
  container: HTMLElement,
  config: StartConfig,
  onExit: () => void,
): () => void {
  let state = config.initialState;
  /** One entry per completed move (human or AI), `history[0]` the starting
   * position. Undo pops off this stack instead of replaying moveHistory
   * backwards, so it stays correct even though moves aren't reversible on
   * their own (a clone can't be un-added without knowing what it converted). */
  let history: GameState[] = [state];
  let selected: Coord | null = null;
  let legalTargets: Action[] = [];
  let justConverted = new Set<string>();
  let lastMove: Coord | null = null;
  let statusMessage = "";
  let aiThinking = false;
  let cancelled = false;
  let aiTimer: ReturnType<typeof setTimeout> | null = null;
  let convertedTimer: ReturnType<typeof setTimeout> | null = null;

  const isAIMode = config.mode === "AI";
  const humanTurnNow = () => !isAIMode || state.currentPlayer === config.humanSide;

  const root = document.createElement("div");
  root.className = "grdn-screen";
  container.appendChild(root);

  function defaultStatus(): string {
    if (state.winner) return "";
    if (isAIMode && !humanTurnNow()) return `${PLAYER_NAME[state.currentPlayer]}가 화단을 살펴보는 중...`;
    return selected
      ? "이동할 화단을 선택하세요."
      : `${PLAYER_NAME[state.currentPlayer]} 차례입니다. 자신의 꽃을 선택하세요.`;
  }

  function render() {
    root.innerHTML = "";

    root.appendChild(renderPlayerPanel("A"));

    const boardHost = document.createElement("div");
    boardHost.className = "grdn-board-host";
    root.appendChild(boardHost);
    renderBoard(boardHost, {
      state,
      interactive: !state.winner && !aiThinking && humanTurnNow(),
      selected,
      legalTargets,
      justConverted,
      lastMove,
      onCellClick: handleCellClick,
    });

    root.appendChild(renderPlayerPanel("B"));

    const status = document.createElement("p");
    status.className = "grdn-status";
    status.textContent = statusMessage || defaultStatus();
    root.appendChild(status);

    if (state.winner) {
      renderResultPanel(root, { state, onRestart: restart, onExit: exit });
    } else {
      const controls = document.createElement("div");
      controls.className = "grdn-controls";
      const undoBtn = document.createElement("button");
      undoBtn.type = "button";
      undoBtn.textContent = "되돌리기";
      undoBtn.disabled = !canUndo();
      undoBtn.addEventListener("click", undo);
      controls.appendChild(undoBtn);
      const exitBtn = document.createElement("button");
      exitBtn.type = "button";
      exitBtn.textContent = "메뉴로";
      exitBtn.addEventListener("click", exit);
      controls.appendChild(exitBtn);
      root.appendChild(controls);
    }
  }

  function renderPlayerPanel(player: Player): HTMLDivElement {
    const counts = countFlowers(state);
    const panel = document.createElement("div");
    panel.className = `grdn-player-panel grdn-player-panel--${player.toLowerCase()}`;
    if (state.currentPlayer === player && !state.winner) panel.classList.add("grdn-player-panel--active");
    panel.innerHTML = `
      <span class="grdn-player-name">${PLAYER_NAME[player]}</span>
      <span class="grdn-player-count">${counts[player]}송이</span>
    `;
    return panel;
  }

  function handleCellClick(row: number, col: number) {
    if (state.winner || aiThinking || !humanTurnNow()) return;

    const player = state.currentPlayer;
    const clickedOwner = cellOwner(state.board[row][col]);

    if (clickedOwner === player) {
      if (selected && selected.row === row && selected.col === col) {
        clearSelection();
      } else {
        selected = { row, col };
        legalTargets = getLegalMovesFrom(state, row, col);
        statusMessage = "";
      }
      render();
      return;
    }

    if (!selected) return;

    const target = legalTargets.find((m) => m.row === row && m.col === col);
    if (!target) {
      clearSelection();
      render();
      return;
    }

    const action: Action =
      target.type === "CLONE"
        ? { type: "CLONE", row, col }
        : { type: "JUMP", fromRow: selected.row, fromCol: selected.col, row, col };

    commitMove(action);
  }

  function clearSelection() {
    selected = null;
    legalTargets = [];
  }

  function commitMove(action: Action) {
    const mover = state.currentPlayer;
    const before = state;
    const { state: after, skippedPlayers } = playMove(state, action);

    clearSelection();
    lastMove = { row: action.row, col: action.col };
    justConverted = convertedCells(before, after, mover, lastMove);
    state = after;
    history.push(state);

    statusMessage = skipMessage(skippedPlayers);
    render();

    if (convertedTimer) clearTimeout(convertedTimer);
    convertedTimer = setTimeout(() => {
      convertedTimer = null;
      if (cancelled) return;
      justConverted = new Set();
      render();
    }, CONVERTED_FLASH_MS);

    if (state.winner || !isAIMode) return;
    if (state.currentPlayer !== config.humanSide) scheduleAIMove();
  }

  function skipMessage(skippedPlayers: Player[]): string {
    if (skippedPlayers.length === 0) return "";
    const [skipped] = skippedPlayers;
    return `${PLAYER_NAME[skipped]}는 심을 수 있는 화단이 없어 이번 턴을 쉽니다.`;
  }

  function scheduleAIMove() {
    aiThinking = true;
    render();
    aiTimer = setTimeout(() => {
      aiTimer = null;
      if (cancelled || state.winner) return;
      const action = getAIMove(state, config.difficulty);
      aiThinking = false;
      commitMove(action);
    }, AI_THINK_DELAY_MS);
  }

  /** True once there's a position to go back to and nothing is mid-flight. */
  function canUndo(): boolean {
    return history.length > 1 && !aiThinking && !state.winner;
  }

  function undo() {
    if (!canUndo()) return;
    if (aiTimer) {
      clearTimeout(aiTimer);
      aiTimer = null;
      aiThinking = false;
    }

    history.pop();
    if (isAIMode) {
      // Land back on the human's own last decision, not on the position
      // where the AI is about to answer it — otherwise "undo" would just
      // hand the turn straight back to the AI with nothing changed for
      // the player.
      while (history.length > 1 && history[history.length - 1].currentPlayer !== config.humanSide) {
        history.pop();
      }
    }
    state = history[history.length - 1];

    clearSelection();
    if (convertedTimer) clearTimeout(convertedTimer);
    convertedTimer = null;
    justConverted = new Set();
    lastMove = lastMoveOf(state);
    statusMessage = "";
    render();
  }

  function restart() {
    if (convertedTimer) clearTimeout(convertedTimer);
    convertedTimer = null;
    state = config.initialState;
    history = [state];
    clearSelection();
    justConverted = new Set();
    lastMove = null;
    statusMessage = "";
    aiThinking = false;
    render();
    if (isAIMode && state.currentPlayer !== config.humanSide) {
      scheduleAIMove();
    }
  }

  function exit() {
    cancelled = true;
    if (aiTimer) clearTimeout(aiTimer);
    if (convertedTimer) clearTimeout(convertedTimer);
    onExit();
  }

  render();
  if (isAIMode && state.currentPlayer !== config.humanSide) {
    scheduleAIMove();
  }

  return () => {
    cancelled = true;
    if (aiTimer) clearTimeout(aiTimer);
    if (convertedTimer) clearTimeout(convertedTimer);
    container.innerHTML = "";
  };
}
