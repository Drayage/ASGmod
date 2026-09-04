import { getAIMove } from "../ai";
import { PIECE_ORIENTATIONS } from "../pieces";
import type { PieceId } from "../pieces";
import { getLegalAnchors, playAction } from "../rules";
import { opponent } from "../types";
import type { Coord, Player } from "../types";
import { renderBoard, type PlacementOption } from "./BoardView";
import type { StartConfig } from "./ModeSelect";
import { renderPieceTray, renderShapeGrid } from "./PieceTray";
import { renderResultPanel } from "./ResultModal";

const PLAYER_NAME: Record<Player, string> = { P1: "P1", P2: "P2" };
const AI_THINK_DELAY_MS = 350;

export function mountGameScreen(container: HTMLElement, config: StartConfig, onExit: () => void): () => void {
  let state = config.initialState;
  let selectedPieceId: PieceId | null = null;
  let orientationIndex = 0;
  let lastMoveCells: Coord[] | null = null;
  let statusMessage = "";
  let aiThinking = false;
  let cancelled = false;
  let aiTimer: ReturnType<typeof setTimeout> | null = null;

  const isAIMode = config.mode === "AI";
  const humanTurnNow = () => !isAIMode || state.currentPlayer === config.humanSide;

  const root = document.createElement("div");
  root.className = "bkd-screen";
  container.appendChild(root);

  function currentOrientation(pieceId: PieceId): Coord[] {
    const shapes = PIECE_ORIENTATIONS[pieceId];
    return shapes[((orientationIndex % shapes.length) + shapes.length) % shapes.length];
  }

  function computePlacements(): PlacementOption[] {
    if (!selectedPieceId || state.winner || aiThinking || !humanTurnNow()) return [];
    const shape = currentOrientation(selectedPieceId);
    const anchors = getLegalAnchors(state, state.currentPlayer, selectedPieceId, orientationIndex);
    return anchors.map((anchor) => ({
      anchor,
      cells: shape.map((c) => ({ row: anchor.row + c.row, col: anchor.col + c.col })),
    }));
  }

  function defaultStatus(): string {
    if (state.winner) return "";
    if (isAIMode && !humanTurnNow()) return `${PLAYER_NAME[state.currentPlayer]}가 생각하는 중...`;
    return selectedPieceId
      ? "연하게 칠해진 칸이 이 조각을 놓을 수 있는 자리예요. 초록 점이 있는 칸을 짚어 놓으세요."
      : `${PLAYER_NAME[state.currentPlayer]} 차례입니다. 아래에서 조각을 고르세요.`;
  }

  function render() {
    root.innerHTML = "";

    const status = document.createElement("p");
    status.className = "bkd-status";
    status.textContent = statusMessage || defaultStatus();
    root.appendChild(status);

    const p2Host = document.createElement("div");
    root.appendChild(p2Host);
    renderPieceTray(p2Host, {
      player: "P2",
      label: "P2",
      remaining: state.remaining.P2,
      interactive: !state.winner && !aiThinking && humanTurnNow() && state.currentPlayer === "P2",
      selectedPieceId: state.currentPlayer === "P2" ? selectedPieceId : null,
      onSelectPiece: (id) => handleSelectPiece("P2", id),
    });

    if (selectedPieceId) {
      root.appendChild(renderSelectedPieceBar(selectedPieceId));
    }

    const boardHost = document.createElement("div");
    boardHost.className = "bkd-board-host";
    root.appendChild(boardHost);
    renderBoard(boardHost, {
      state,
      interactive: !state.winner && !aiThinking && humanTurnNow(),
      placements: computePlacements(),
      lastMoveCells,
      onAnchorClick: handleAnchorClick,
    });

    const p1Host = document.createElement("div");
    root.appendChild(p1Host);
    renderPieceTray(p1Host, {
      player: "P1",
      label: "P1",
      remaining: state.remaining.P1,
      interactive: !state.winner && !aiThinking && humanTurnNow() && state.currentPlayer === "P1",
      selectedPieceId: state.currentPlayer === "P1" ? selectedPieceId : null,
      onSelectPiece: (id) => handleSelectPiece("P1", id),
    });

    if (state.winner) {
      renderResultPanel(root, { state, onRestart: restart, onExit: exit });
    } else {
      const controls = document.createElement("div");
      controls.className = "bkd-controls";
      const exitBtn = document.createElement("button");
      exitBtn.type = "button";
      exitBtn.textContent = "메뉴로";
      exitBtn.addEventListener("click", exit);
      controls.appendChild(exitBtn);
      root.appendChild(controls);
    }
  }

  function renderSelectedPieceBar(pieceId: PieceId): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "bkd-selected-bar";

    const preview = document.createElement("div");
    preview.className = "bkd-selected-preview";
    preview.appendChild(renderShapeGrid(currentOrientation(pieceId), state.currentPlayer, 18));
    bar.appendChild(preview);

    const rotateBtn = document.createElement("button");
    rotateBtn.type = "button";
    rotateBtn.textContent = "회전";
    rotateBtn.addEventListener("click", () => {
      orientationIndex += 1;
      render();
    });
    bar.appendChild(rotateBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "선택 취소";
    cancelBtn.addEventListener("click", () => {
      clearSelection();
      render();
    });
    bar.appendChild(cancelBtn);

    return bar;
  }

  function clearSelection() {
    selectedPieceId = null;
    orientationIndex = 0;
  }

  function handleSelectPiece(player: Player, pieceId: PieceId) {
    if (state.winner || aiThinking || !humanTurnNow() || player !== state.currentPlayer) return;
    if (selectedPieceId === pieceId) {
      clearSelection();
    } else {
      selectedPieceId = pieceId;
      orientationIndex = 0;
    }
    statusMessage = "";
    render();
  }

  function handleAnchorClick(row: number, col: number) {
    if (!selectedPieceId || state.winner || aiThinking || !humanTurnNow()) return;
    const placement = computePlacements().find((p) => p.anchor.row === row && p.anchor.col === col);
    if (!placement) return;
    commitAction(selectedPieceId, placement.cells);
  }

  function commitAction(pieceId: PieceId, cells: Coord[]) {
    const actingPlayer = state.currentPlayer;
    const after = playAction(state, { kind: "PLACE", pieceId, cells });

    clearSelection();
    lastMoveCells = cells;
    state = after;

    if (!state.winner && state.currentPlayer !== opponent(actingPlayer)) {
      statusMessage = `${PLAYER_NAME[opponent(actingPlayer)]}가 놓을 수 있는 조각이 없어 차례를 건너뜁니다.`;
    } else {
      statusMessage = "";
    }
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
      commitAction(action.pieceId, action.cells);
    }, AI_THINK_DELAY_MS);
  }

  function restart() {
    state = config.initialState;
    clearSelection();
    lastMoveCells = null;
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
