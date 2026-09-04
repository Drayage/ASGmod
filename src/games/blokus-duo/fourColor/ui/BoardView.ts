import { BOARD_SIZE, START_CELL } from "../types";
import type { GameState } from "../types";
import type { Coord } from "../../types";

export interface PlacementOption {
  anchor: Coord;
  cells: Coord[];
}

export interface BoardRenderOptions {
  state: GameState;
  interactive: boolean;
  placements: PlacementOption[];
  lastMoveCells: Coord[] | null;
  onAnchorClick: (row: number, col: number) => void;
}

const START_MARKERS: Array<[keyof typeof START_CELL, string]> = [
  ["BLUE", "bkd-cell--start-blue"],
  ["YELLOW", "bkd-cell--start-yellow"],
  ["RED", "bkd-cell--start-red"],
  ["GREEN", "bkd-cell--start-green"],
];

export function renderBoard(host: HTMLElement, options: BoardRenderOptions): void {
  const { state, interactive, placements, lastMoveCells, onAnchorClick } = options;
  host.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "bkd-board bkd-board--four";
  grid.style.setProperty("--size", String(BOARD_SIZE));

  const cellEls: HTMLButtonElement[][] = [];
  for (let row = 0; row < BOARD_SIZE; row++) {
    const rowEls: HTMLButtonElement[] = [];
    for (let col = 0; col < BOARD_SIZE; col++) {
      const owner = state.board[row][col];
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "bkd-cell";
      cell.disabled = true;
      if (owner) {
        cell.classList.add(`bkd-cell--${owner.toLowerCase()}`);
        cell.setAttribute("aria-label", `${row + 1}행 ${col + 1}열, ${owner}`);
      } else {
        for (const [color, markerClass] of START_MARKERS) {
          if (row === START_CELL[color].row && col === START_CELL[color].col) cell.classList.add(markerClass);
        }
        cell.setAttribute("aria-label", `${row + 1}행 ${col + 1}열, 빈 칸`);
      }
      rowEls.push(cell);
      grid.appendChild(cell);
    }
    cellEls.push(rowEls);
  }

  if (lastMoveCells) {
    for (const c of lastMoveCells) cellEls[c.row][c.col].classList.add("bkd-cell--last-move");
  }

  if (interactive) {
    for (const placement of placements) {
      const anchorEl = cellEls[placement.anchor.row][placement.anchor.col];
      anchorEl.disabled = false;
      anchorEl.classList.add("bkd-cell--anchor");
      anchorEl.addEventListener("click", () => onAnchorClick(placement.anchor.row, placement.anchor.col));
      anchorEl.addEventListener("mouseenter", () => {
        for (const c of placement.cells) cellEls[c.row][c.col].classList.add("bkd-cell--ghost");
      });
      anchorEl.addEventListener("mouseleave", () => {
        for (const c of placement.cells) cellEls[c.row][c.col].classList.remove("bkd-cell--ghost");
      });
    }
  }

  host.appendChild(grid);
}
