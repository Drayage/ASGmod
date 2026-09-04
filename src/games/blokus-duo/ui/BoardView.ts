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
    // Touch has no hover, so a single tap on an anchor used to place the
    // piece immediately with no preview at all. On a coarse (touch)
    // pointer, the first tap on an anchor now only previews it — the same
    // ghost a mouse gets from hovering — and a second tap on that same,
    // now-previewed anchor confirms the placement. A real mouse is
    // unaffected: hover already shows the ghost before any click, so the
    // first click there still places directly.
    const isTouchLike = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    let armedKey: string | null = null;

    const clearGhosts = () => {
      for (const row of cellEls) for (const cell of row) cell.classList.remove("bkd-cell--ghost");
    };
    const showGhost = (cells: Coord[]) => {
      for (const c of cells) cellEls[c.row][c.col].classList.add("bkd-cell--ghost");
    };

    // Faintly shade every cell any legal placement of the current piece
    // would cover, all at once — without this, the only way to discover
    // where a piece actually lands (and what shape it makes) was to hover
    // or tap one anchor dot at a time, which is exactly what made this
    // hard to read. Hovering/tapping a specific anchor still intensifies
    // just that one placement into the full ghost, as a placement preview.
    for (const placement of placements) {
      for (const c of placement.cells) cellEls[c.row][c.col].classList.add("bkd-cell--hint");
    }

    for (const placement of placements) {
      const key = `${placement.anchor.row},${placement.anchor.col}`;
      const anchorEl = cellEls[placement.anchor.row][placement.anchor.col];
      anchorEl.disabled = false;
      anchorEl.classList.add("bkd-cell--anchor");
      anchorEl.addEventListener("mouseenter", () => showGhost(placement.cells));
      anchorEl.addEventListener("mouseleave", clearGhosts);
      anchorEl.addEventListener("click", () => {
        if (isTouchLike && armedKey !== key) {
          clearGhosts();
          showGhost(placement.cells);
          armedKey = key;
          return;
        }
        onAnchorClick(placement.anchor.row, placement.anchor.col);
      });
    }
  }

  host.appendChild(grid);
}
