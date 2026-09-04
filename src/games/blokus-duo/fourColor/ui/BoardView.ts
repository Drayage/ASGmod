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

/** Which of a placement's cells sit on the outer edge of its shape, per
 * side — used to outline each candidate placement with its own silhouette
 * instead of a flat, undifferentiated fill, so neighboring or overlapping
 * placements don't blur into one indistinct blob. */
function silhouetteEdges(cells: Coord[]): Array<{ coord: Coord; top: boolean; right: boolean; bottom: boolean; left: boolean }> {
  const set = new Set(cells.map((c) => `${c.row},${c.col}`));
  return cells.map((c) => ({
    coord: c,
    top: !set.has(`${c.row - 1},${c.col}`),
    right: !set.has(`${c.row},${c.col + 1}`),
    bottom: !set.has(`${c.row + 1},${c.col}`),
    left: !set.has(`${c.row},${c.col - 1}`),
  }));
}

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
    // hard to read. Each placement also gets its own outline traced around
    // its true silhouette (not just a filled cell), so when two candidate
    // placements sit next to or overlap each other, they still read as
    // distinct shapes instead of merging into one blob. Hovering/tapping a
    // specific anchor still intensifies just that one placement into the
    // full ghost, as a placement preview.
    for (const placement of placements) {
      for (const edge of silhouetteEdges(placement.cells)) {
        const cellEl = cellEls[edge.coord.row][edge.coord.col];
        cellEl.classList.add("bkd-cell--hint");
        if (edge.top) cellEl.classList.add("bkd-cell--hint-top");
        if (edge.right) cellEl.classList.add("bkd-cell--hint-right");
        if (edge.bottom) cellEl.classList.add("bkd-cell--hint-bottom");
        if (edge.left) cellEl.classList.add("bkd-cell--hint-left");
      }
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
