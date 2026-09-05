import { BOARD_SIZE, START_CELL } from "../types";
import type { GameState } from "../types";
import type { Coord } from "../../types";

/** One legal placement of the currently selected piece+orientation: the
 * anchor square the placement is identified by, and every cell it would
 * actually cover. Any of `cells` may be clicked to select this placement —
 * `anchor` is just the coordinate passed back to identify which one. */
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

/** A distinct hue per placement index, spread evenly around the color
 * wheel — a rainbow of candidates rather than one flat color, so when two
 * placements overlap the same board cells, which candidate is which stays
 * readable instead of blending into a single indistinct highlight. */
function placementColor(index: number, total: number): string {
  const hue = Math.round((index * 360) / Math.max(total, 1)) % 360;
  return `hsl(${hue} 78% 45%)`;
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
    // Every placement paints its own true, full silhouette as a
    // translucent overlay layer (pointer-events: none, so it never
    // intercepts clicks) on every cell it covers — not just the cells it
    // "wins" — so where two candidates overlap, both colors show through
    // and blend instead of one hiding the other.
    const placementOverlays: HTMLElement[][] = placements.map(() => []);
    placements.forEach((placement, index) => {
      const color = placementColor(index, placements.length);
      for (const edge of silhouetteEdges(placement.cells)) {
        const overlay = document.createElement("span");
        overlay.className = "bkd-hint-overlay";
        overlay.style.setProperty("--hint-color", color);
        if (edge.top) overlay.classList.add("bkd-hint-overlay--top");
        if (edge.right) overlay.classList.add("bkd-hint-overlay--right");
        if (edge.bottom) overlay.classList.add("bkd-hint-overlay--bottom");
        if (edge.left) overlay.classList.add("bkd-hint-overlay--left");
        cellEls[edge.coord.row][edge.coord.col].appendChild(overlay);
        placementOverlays[index].push(overlay);
      }
    });

    // Touch has no hover, so a single tap used to place the piece
    // immediately with no preview at all. On a coarse (touch) pointer, the
    // first tap on a placement now only previews it — the same
    // intensified overlay a mouse gets from hovering — and a second tap on
    // that same, now-previewed placement confirms it. A real mouse is
    // unaffected: hover already shows the preview before any click, so the
    // first click there still places directly.
    const isTouchLike = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    let armedKey: string | null = null;

    const clearGhosts = () => {
      for (const overlays of placementOverlays) for (const el of overlays) el.classList.remove("bkd-hint-overlay--active");
    };
    const showGhost = (index: number) => {
      for (const el of placementOverlays[index]) el.classList.add("bkd-hint-overlay--active");
    };

    // Interaction is still resolved one-owner-per-cell (first-listed
    // placement wins a shared cell) so a click is never ambiguous about
    // which candidate it means, even though the visuals above show every
    // overlapping candidate at once. A placement that lost every other
    // cell to an earlier one always keeps its own anchor cell reserved, so
    // it's never left with nothing clickable.
    const owner = new Map<string, number>();
    for (let i = 0; i < placements.length; i++) {
      for (const c of placements[i].cells) {
        const key = `${c.row},${c.col}`;
        if (!owner.has(key)) owner.set(key, i);
      }
    }
    placements.forEach((placement, index) => {
      const anchorKey = `${placement.anchor.row},${placement.anchor.col}`;
      const hasOwnCell = placement.cells.some((c) => owner.get(`${c.row},${c.col}`) === index);
      if (!hasOwnCell) owner.set(anchorKey, index);
    });

    placements.forEach((placement, index) => {
      const key = `${placement.anchor.row},${placement.anchor.col}`;
      for (const c of placement.cells) {
        const cellKey = `${c.row},${c.col}`;
        if (owner.get(cellKey) !== index) continue;

        const cellEl = cellEls[c.row][c.col];
        cellEl.disabled = false;
        cellEl.classList.add("bkd-cell--clickable");
        cellEl.addEventListener("mouseenter", () => showGhost(index));
        cellEl.addEventListener("mouseleave", clearGhosts);
        cellEl.addEventListener("click", () => {
          if (isTouchLike && armedKey !== key) {
            clearGhosts();
            showGhost(index);
            armedKey = key;
            return;
          }
          onAnchorClick(placement.anchor.row, placement.anchor.col);
        });
      }
    });
  }

  host.appendChild(grid);
}
