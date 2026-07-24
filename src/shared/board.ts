/** Small helpers shared by grid-based abstract strategy games. Not a required
 * dependency — games are free to render however they like. */

export interface GridOptions {
  rows: number;
  cols: number;
  onCellClick?: (row: number, col: number, cell: HTMLButtonElement) => void;
  cellLabel?: (row: number, col: number) => string;
}

/** Builds a `<div class="board-grid">` of `<button class="board-cell">`s and
 * returns the grid element plus a lookup by [row][col]. */
export function createGrid(options: GridOptions): {
  grid: HTMLDivElement;
  cells: HTMLButtonElement[][];
} {
  const { rows, cols, onCellClick, cellLabel } = options;
  const grid = document.createElement("div");
  grid.className = "board-grid";
  grid.style.setProperty("--rows", String(rows));
  grid.style.setProperty("--cols", String(cols));

  const cells: HTMLButtonElement[][] = [];
  for (let row = 0; row < rows; row++) {
    const rowCells: HTMLButtonElement[] = [];
    for (let col = 0; col < cols; col++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "board-cell";
      cell.setAttribute("aria-label", cellLabel?.(row, col) ?? `${row + 1}, ${col + 1}`);
      cell.addEventListener("click", () => onCellClick?.(row, col, cell));
      grid.appendChild(cell);
      rowCells.push(cell);
    }
    cells.push(rowCells);
  }

  return { grid, cells };
}
