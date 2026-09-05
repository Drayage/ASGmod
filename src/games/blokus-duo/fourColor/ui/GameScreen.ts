import { PIECE_ORIENTATIONS } from "../../pieces";
import type { PieceId } from "../../pieces";
import { getAIMove } from "../ai";
import type { Difficulty } from "../ai";
import { getLegalAnchors, playAction } from "../rules";
import { COLOR_OWNER, nextColor } from "../types";
import type { Color, GameState, Player } from "../types";
import type { Coord } from "../../types";
import type { Mode } from "../../storage";
import { renderBoard, type PlacementOption } from "./BoardView";
import { renderPieceTray, renderShapeGrid } from "./PieceTray";
import { renderResultPanel } from "./ResultModal";

export interface FourColorStartConfig {
  mode: Mode;
  difficulty: Difficulty;
  humanSide: Player;
  initialState: GameState;
}

const PLAYER_NAME: Record<Player, string> = { P1: "P1 (블루+레드)", P2: "P2 (옐로우+그린)" };
const COLOR_LABEL: Record<Color, string> = { BLUE: "블루", YELLOW: "옐로우", RED: "레드", GREEN: "그린" };
const AI_THINK_DELAY_MS = 350;

export function mountFourColorGameScreen(
  container: HTMLElement,
  config: FourColorStartConfig,
  onExit: () => void,
): () => void {
  let state = config.initialState;
  let selectedPieceId: PieceId | null = null;
  let orientationIndex = 0;
  let lastMoveCells: Coord[] | null = null;
  let statusMessage = "";
  let aiThinking = false;
  let cancelled = false;
  let aiTimer: ReturnType<typeof setTimeout> | null = null;

  const isAIMode = config.mode === "AI";
  const activePlayer = () => COLOR_OWNER[state.currentColor];
  const humanTurnNow = () => !isAIMode || activePlayer() === config.humanSide;

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
    const anchors = getLegalAnchors(state, state.currentColor, selectedPieceId, orientationIndex);
    return anchors.map((anchor) => ({
      anchor,
      cells: shape.map((c) => ({ row: anchor.row + c.row, col: anchor.col + c.col })),
    }));
  }

  function defaultStatus(): string {
    if (state.winner) return "";
    if (isAIMode && !humanTurnNow()) return `${COLOR_LABEL[state.currentColor]}가 생각하는 중...`;
    return selectedPieceId
      ? "색칠된 모양이 이 조각을 놓을 수 있는 자리예요. 원하는 모양 위를 짚어 놓으세요."
      : `${COLOR_LABEL[state.currentColor]} (${PLAYER_NAME[activePlayer()]}) 차례입니다.`;
  }

  function render() {
    root.innerHTML = "";

    const status = document.createElement("p");
    status.className = "bkd-status";
    status.textContent = statusMessage || defaultStatus();
    root.appendChild(status);

    const topRow = document.createElement("div");
    topRow.className = "bkd-tray-pair";
    for (const color of ["YELLOW", "GREEN"] as Color[]) {
      const host = document.createElement("div");
      topRow.appendChild(host);
      renderColorTray(host, color);
    }
    root.appendChild(topRow);

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

    const bottomRow = document.createElement("div");
    bottomRow.className = "bkd-tray-pair";
    for (const color of ["BLUE", "RED"] as Color[]) {
      const host = document.createElement("div");
      bottomRow.appendChild(host);
      renderColorTray(host, color);
    }
    root.appendChild(bottomRow);

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

  function renderColorTray(host: HTMLElement, color: Color) {
    renderPieceTray(host, {
      color,
      label: `${COLOR_LABEL[color]} · ${PLAYER_NAME[COLOR_OWNER[color]]}`,
      remaining: state.remaining[color],
      interactive: !state.winner && !aiThinking && humanTurnNow() && state.currentColor === color,
      selectedPieceId: state.currentColor === color ? selectedPieceId : null,
      onSelectPiece: (id) => handleSelectPiece(color, id),
    });
  }

  function renderSelectedPieceBar(pieceId: PieceId): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "bkd-selected-bar";

    const preview = document.createElement("div");
    preview.className = "bkd-selected-preview";
    preview.appendChild(renderShapeGrid(currentOrientation(pieceId), state.currentColor, 18));
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

  function handleSelectPiece(color: Color, pieceId: PieceId) {
    if (state.winner || aiThinking || !humanTurnNow() || color !== state.currentColor) return;
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
    const actingColor = state.currentColor;
    const after = playAction(state, { kind: "PLACE", color: actingColor, pieceId, cells });

    clearSelection();
    lastMoveCells = cells;
    state = after;

    const expectedNext = nextColor(actingColor);
    statusMessage =
      !state.winner && state.currentColor !== expectedNext
        ? `차례를 건너뛰어 ${COLOR_LABEL[state.currentColor]} 차례입니다.`
        : "";
    render();

    if (state.winner || !isAIMode) return;
    if (activePlayer() !== config.humanSide) scheduleAIMove();
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
    if (isAIMode && activePlayer() !== config.humanSide) {
      scheduleAIMove();
    }
  }

  function exit() {
    cancelled = true;
    if (aiTimer) clearTimeout(aiTimer);
    onExit();
  }

  render();
  if (isAIMode && activePlayer() !== config.humanSide) {
    scheduleAIMove();
  }

  return () => {
    cancelled = true;
    if (aiTimer) clearTimeout(aiTimer);
    container.innerHTML = "";
  };
}
