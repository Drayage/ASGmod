import { getAIMove } from "../ai";
import { CARRY_LIMIT, directionDelta, inBounds, topStone } from "../types";
import type { Action, Coord, Direction, Player, StoneKind } from "../types";
import { isLegalMove, isLegalPlace, playAction } from "../rules";
import { renderBoard, type BoardTarget, type Selection } from "./BoardView";
import type { StartConfig } from "./ModeSelect";
import { renderPalette } from "./PalettePanel";
import { renderResultPanel } from "./ResultModal";

const PLAYER_NAME: Record<Player, string> = { P1: "P1", P2: "P2" };
const AI_THINK_DELAY_MS = 350;
const DIRECTIONS: Direction[] = ["UP", "DOWN", "LEFT", "RIGHT"];

interface Target extends BoardTarget {
  action: Action;
}

/** How a carried group of `carry` stones spreads across `distance`
 * squares: one stone dribbled at each square along the way, with
 * whatever's left landing all together at the final square. Simpler than
 * every possible drop composition, but covers the moves a casual game
 * actually needs — including a lone capstone (the last stone remaining)
 * flattening a standing stone at the far end of the move. */
function uniformDrops(carry: number, distance: number): number[] {
  if (distance <= 1) return [carry];
  return [...Array(distance - 1).fill(1), carry - (distance - 1)];
}

export function mountGameScreen(container: HTMLElement, config: StartConfig, onExit: () => void): () => void {
  let state = config.initialState;
  let selection: Selection = null;
  let lastMoveCells: Coord[] | null = null;
  let statusMessage = "";
  let aiThinking = false;
  let cancelled = false;
  let aiTimer: ReturnType<typeof setTimeout> | null = null;

  const isAIMode = config.mode === "AI";
  const humanTurnNow = () => !isAIMode || state.currentPlayer === config.humanSide;

  const root = document.createElement("div");
  root.className = "stp-screen";
  container.appendChild(root);

  function computeTargets(): Target[] {
    if (!selection || state.winner || aiThinking || !humanTurnNow()) return [];

    if (selection.kind === "PLACE") {
      const targets: Target[] = [];
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
          if (isLegalPlace(state, { row, col }, selection.stoneKind)) {
            targets.push({ to: { row, col }, action: { kind: "PLACE", to: { row, col }, stoneKind: selection.stoneKind } });
          }
        }
      }
      return targets;
    }

    const { from, carry } = selection;
    const targets: Target[] = [];
    for (const direction of DIRECTIONS) {
      const delta = directionDelta(direction);
      for (let distance = 1; distance <= carry; distance++) {
        const to: Coord = { row: from.row + delta.row * distance, col: from.col + delta.col * distance };
        if (!inBounds(to.row, to.col)) break;
        const drops = uniformDrops(carry, distance);
        if (isLegalMove(state, from, direction, drops)) {
          targets.push({ to, action: { kind: "MOVE", from, direction, drops } });
        }
      }
    }
    return targets;
  }

  function defaultStatus(): string {
    if (state.winner) return "";
    if (isAIMode && !humanTurnNow()) return `${PLAYER_NAME[state.currentPlayer]}가 생각하는 중...`;
    if (!state.hasPlayedFirstMove[state.currentPlayer]) return `${PLAYER_NAME[state.currentPlayer]} 차례입니다. 상대의 평돌을 놓아주세요.`;
    if (selection?.kind === "STACK") return "표시된 칸을 눌러 옮기거나, 아래에서 들고 갈 돌 수를 바꾸세요.";
    if (selection?.kind === "PLACE") return "빈 칸을 눌러 놓으세요.";
    return `${PLAYER_NAME[state.currentPlayer]} 차례입니다. 돌을 고르거나, 내 돌무더기를 눌러 옮기세요.`;
  }

  function render() {
    root.innerHTML = "";

    const status = document.createElement("p");
    status.className = "stp-status";
    status.textContent = statusMessage || defaultStatus();
    root.appendChild(status);

    const paletteHost = document.createElement("div");
    root.appendChild(paletteHost);
    renderPalette(paletteHost, {
      state,
      player: state.currentPlayer,
      interactive: !state.winner && !aiThinking && humanTurnNow(),
      selection,
      onSelectKind: handleSelectKind,
    });

    if (selection?.kind === "STACK") {
      root.appendChild(renderCarryStepper(selection.from, selection.carry));
    }

    const boardHost = document.createElement("div");
    boardHost.className = "stp-board-host";
    root.appendChild(boardHost);
    renderBoard(boardHost, {
      state,
      interactive: !state.winner && !aiThinking && humanTurnNow(),
      selection,
      targets: computeTargets(),
      lastMoveCells,
      onCellClick: handleCellClick,
    });

    if (state.winner) {
      renderResultPanel(root, { state, onRestart: restart, onExit: exit });
    } else {
      const controls = document.createElement("div");
      controls.className = "stp-controls";
      const exitBtn = document.createElement("button");
      exitBtn.type = "button";
      exitBtn.textContent = "메뉴로";
      exitBtn.addEventListener("click", exit);
      controls.appendChild(exitBtn);
      root.appendChild(controls);
    }
  }

  function renderCarryStepper(from: Coord, carry: number): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "stp-carry-bar";

    const label = document.createElement("span");
    label.textContent = "들고 갈 돌 수:";
    bar.appendChild(label);

    const maxCarry = Math.min(CARRY_LIMIT, state.board[from.row][from.col].length);
    for (let n = 1; n <= maxCarry; n++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = String(n);
      if (n === carry) btn.classList.add("stp-carry-btn--selected");
      btn.addEventListener("click", () => {
        selection = { kind: "STACK", from, carry: n };
        render();
      });
      bar.appendChild(btn);
    }

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "선택 취소";
    cancelBtn.addEventListener("click", () => {
      selection = null;
      render();
    });
    bar.appendChild(cancelBtn);

    return bar;
  }

  function handleSelectKind(stoneKind: StoneKind) {
    if (state.winner || aiThinking || !humanTurnNow()) return;
    selection = selection?.kind === "PLACE" && selection.stoneKind === stoneKind ? null : { kind: "PLACE", stoneKind };
    statusMessage = "";
    render();
  }

  function handleCellClick(row: number, col: number) {
    if (state.winner || aiThinking || !humanTurnNow()) return;
    const stack = state.board[row][col];
    const top = topStone(stack);
    const targets = computeTargets();
    const target = targets.find((t) => t.to.row === row && t.to.col === col);

    if (target) {
      commitAction(target.action);
      return;
    }

    if (selection?.kind === "STACK" && selection.from.row === row && selection.from.col === col) {
      selection = null;
      render();
      return;
    }

    if (top && top.owner === state.currentPlayer && state.hasPlayedFirstMove[state.currentPlayer]) {
      selection = { kind: "STACK", from: { row, col }, carry: 1 };
      statusMessage = "";
      render();
      return;
    }

    selection = null;
    render();
  }

  function commitAction(action: Action) {
    const after = playAction(state, action);

    selection = null;
    lastMoveCells = action.kind === "PLACE" ? [action.to] : moveCells(action.from, action.direction, action.drops);
    state = after;
    statusMessage = "";
    render();

    if (state.winner || !isAIMode) return;
    if (state.currentPlayer !== config.humanSide) scheduleAIMove();
  }

  function moveCells(from: Coord, direction: Direction, drops: number[]): Coord[] {
    const delta = directionDelta(direction);
    const cells = [from];
    for (let i = 0; i < drops.length; i++) {
      cells.push({ row: from.row + delta.row * (i + 1), col: from.col + delta.col * (i + 1) });
    }
    return cells;
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
    selection = null;
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
