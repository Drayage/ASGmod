import { BOARD_SIZE } from "../types";
import type { Coord, GameState, Stack, StoneKind } from "../types";

export type Selection = { kind: "PLACE"; stoneKind: StoneKind } | { kind: "STACK"; from: Coord; carry: number } | null;

export interface BoardTarget {
  to: Coord;
}

export interface BoardRenderOptions {
  state: GameState;
  interactive: boolean;
  selection: Selection;
  targets: BoardTarget[];
  lastMoveCells: Coord[] | null;
  onCellClick: (row: number, col: number) => void;
}

function key(row: number, col: number): string {
  return `${row},${col}`;
}

function renderStack(stack: Stack): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "stp-stack";
  const top = stack[stack.length - 1];

  const piece = document.createElement("div");
  piece.className = `stp-piece stp-piece--${top.owner.toLowerCase()} stp-piece--${top.kind.toLowerCase()}`;
  if (top.kind === "CAP") {
    const inner = document.createElement("span");
    inner.className = "stp-piece-cap-dot";
    piece.appendChild(inner);
  }
  wrap.appendChild(piece);

  if (stack.length > 1) {
    const badge = document.createElement("span");
    badge.className = "stp-stack-count";
    badge.textContent = String(stack.length);
    wrap.appendChild(badge);
  }

  return wrap;
}

export function renderBoard(host: HTMLElement, options: BoardRenderOptions): void {
  const { state, interactive, selection, targets, lastMoveCells, onCellClick } = options;
  host.innerHTML = "";

  const targetKeys = new Set(targets.map((t) => key(t.to.row, t.to.col)));

  const grid = document.createElement("div");
  grid.className = "stp-board";
  grid.style.setProperty("--size", String(BOARD_SIZE));

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const stack = state.board[row][col];
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "stp-cell";

      const isTarget = targetKeys.has(key(row, col));
      const isSelectedStack = selection?.kind === "STACK" && selection.from.row === row && selection.from.col === col;

      if (stack.length > 0) {
        cell.appendChild(renderStack(stack));
        const top = stack[stack.length - 1];
        cell.setAttribute("aria-label", `${row + 1}행 ${col + 1}열, ${top.owner} 스택 (${stack.length}단)`);
      } else {
        cell.setAttribute("aria-label", `${row + 1}행 ${col + 1}열, 빈 칸`);
      }

      const clickable = interactive && (isTarget || (stack.length > 0 && stack[stack.length - 1].owner === state.currentPlayer) || selection !== null);
      cell.disabled = !clickable;
      if (clickable) cell.addEventListener("click", () => onCellClick(row, col));

      if (isTarget) {
        cell.classList.add("stp-cell--target");
        const marker = document.createElement("span");
        marker.className = "stp-target-marker";
        cell.appendChild(marker);
      }
      if (isSelectedStack) cell.classList.add("stp-cell--selected");
      if (lastMoveCells?.some((c) => c.row === row && c.col === col)) cell.classList.add("stp-cell--last-move");

      grid.appendChild(cell);
    }
  }

  host.appendChild(grid);
}
