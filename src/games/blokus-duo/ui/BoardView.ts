import { BOARD_SIZE, START_CELL } from "../types";
import type { Coord, GameState } from "../types";

/** One legal placement of the currently selected piece+orientation: the
 * anchor square a click lands on, and every cell that placement would
 * actually cover (used for the hover ghost preview). */
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

export function renderBoard(host: HTMLElement, options: BoardRenderOptions): void {
  const { state, interactive, placements, lastMoveCells, onAnchorClick } = options;
  host.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "bkd-board";
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
        if (row === START_CELL.P1.row && col === START_CELL.P1.col) cell.classList.add("bkd-cell--start-p1");
        if (row === START_CELL.P2.row && col === START_CELL.P2.col) cell.classList.add("bkd-cell--start-p2");
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
