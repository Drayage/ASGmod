import { getAIMove } from "../ai";
import { getLegalDropTargets, getMovesFrom, playAction } from "../rules";
import type { Action, Coord, HandPieceType, Player } from "../types";
import type { StartConfig } from "./ModeSelect";
import { renderBoard, type Selection } from "./BoardView";
import { renderResultPanel } from "./ResultModal";

const PLAYER_NAME: Record<Player, string> = { A: "A", B: "B" };
const AI_THINK_DELAY_MS = 350;

export function mountGameScreen(container: HTMLElement, config: StartConfig, onExit: () => void): () => void {
  let state = config.initialState;
  let selected: Selection = null;
  let legalTargets: Coord[] = [];
  let lastMove: { from: Coord | null; to: Coord } | null = null;
  let statusMessage = "";
  let aiThinking = false;
  let cancelled = false;
  let aiTimer: ReturnType<typeof setTimeout> | null = null;

  const isAIMode = config.mode === "AI";
  const humanTurnNow = () => !isAIMode || state.currentPlayer === config.humanSide;

  const root = document.createElement("div");
  root.className = "asg-screen";
  container.appendChild(root);

  function defaultStatus(): string {
    if (state.winner) return "";
    if (isAIMode && !humanTurnNow()) return `${PLAYER_NAME[state.currentPlayer]}가 생각하는 중...`;
    return selected
      ? "이동하거나 내려놓을 칸을 선택하세요."
      : `${PLAYER_NAME[state.currentPlayer]} 차례입니다. 말을 선택하세요.`;
  }

  function render() {
    root.innerHTML = "";

    const status = document.createElement("p");
    status.className = "asg-status";
    status.textContent = statusMessage || defaultStatus();
    root.appendChild(status);

    const boardHost = document.createElement("div");
    boardHost.className = "asg-board-host";
    root.appendChild(boardHost);
    renderBoard(boardHost, {
      state,
      interactive: !state.winner && !aiThinking && humanTurnNow(),
      selected,
      legalTargets,
      lastMove,
      onCellClick: handleCellClick,
      onHandPieceClick: handleHandPieceClick,
    });

    if (state.winner) {
      renderResultPanel(root, { state, onRestart: restart, onExit: exit });
    } else {
      const controls = document.createElement("div");
      controls.className = "asg-controls";
      const exitBtn = document.createElement("button");
      exitBtn.type = "button";
      exitBtn.textContent = "메뉴로";
      exitBtn.addEventListener("click", exit);
      controls.appendChild(exitBtn);
      root.appendChild(controls);
    }
  }

  function clearSelection() {
    selected = null;
    legalTargets = [];
  }

  function handleCellClick(row: number, col: number) {
    if (state.winner || aiThinking || !humanTurnNow()) return;

    const player = state.currentPlayer;
    const piece = state.board[row][col];

    if (piece && piece.owner === player) {
      if (selected?.kind === "BOARD" && selected.coord.row === row && selected.coord.col === col) {
        clearSelection();
      } else {
        selected = { kind: "BOARD", coord: { row, col } };
        legalTargets = getMovesFrom(state, { row, col });
        statusMessage = "";
      }
      render();
      return;
    }

    if (!selected) return;

    const isTarget = legalTargets.some((t) => t.row === row && t.col === col);
    if (!isTarget) {
      clearSelection();
      render();
      return;
    }

    const action: Action =
      selected.kind === "BOARD"
        ? { kind: "MOVE", from: selected.coord, to: { row, col } }
        : { kind: "DROP", pieceType: selected.pieceType, to: { row, col } };

    commitAction(action);
  }

  function handleHandPieceClick(player: Player, pieceType: HandPieceType) {
    if (state.winner || aiThinking || !humanTurnNow() || player !== state.currentPlayer) return;

    if (selected?.kind === "HAND" && selected.pieceType === pieceType) {
      clearSelection();
    } else {
      selected = { kind: "HAND", pieceType };
      legalTargets = getLegalDropTargets(state, pieceType, player);
      statusMessage = "";
    }
    render();
  }

  function commitAction(action: Action) {
    const from = action.kind === "MOVE" ? action.from : null;
    const { state: after } = playAction(state, action);

    clearSelection();
    lastMove = { from, to: action.to };
    state = after;
    statusMessage = "";
    render();

    if (state.winner || !isAIMode) return;
    if (state.currentPlayer !== config.humanSide) scheduleAIMove();
  }

  function scheduleAIMove() {
    aiThinking = true;
    render();
    aiTimer = setTimeout(() => {
      aiTimer = null;
      if (cancelled || state.winner) return;
      const action = getAIMove(state, config.difficulty);
      aiThinking = false;
      commitAction(action);
    }, AI_THINK_DELAY_MS);
  }

  function restart() {
    state = config.initialState;
    clearSelection();
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
    onExit();
  }

  render();
  if (isAIMode && state.currentPlayer !== config.humanSide) {
    scheduleAIMove();
  }

  return () => {
    cancelled = true;
    if (aiTimer) clearTimeout(aiTimer);
    container.innerHTML = "";
  };
}
