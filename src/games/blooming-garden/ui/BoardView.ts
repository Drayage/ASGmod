import type { Action, Coord, GameState } from "../types";

export interface BoardRenderOptions {
  state: GameState;
  /** False while it's the AI's turn, or the game has ended. */
  interactive: boolean;
  /** The player's currently selected flower, if any. */
  selected: Coord | null;
  /** Legal targets for the selected flower — empty when nothing is selected. */
  legalTargets: Action[];
  /** Cells whose flower was just converted, for a brief highlight. */
  justConverted: ReadonlySet<string>;
  /** Where the last move landed, so the board still reads clearly after the
   * fact (e.g. when reviewing before dismissing the result panel). */
  lastMove: Coord | null;
  onCellClick: (row: number, col: number) => void;
}

function key(row: number, col: number): string {
  return `${row},${col}`;
}

export function renderBoard(host: HTMLElement, options: BoardRenderOptions): void {
  const { state, interactive, selected, legalTargets, justConverted, lastMove, onCellClick } = options;
  host.innerHTML = "";

  const size = state.board.length;
  const grid = document.createElement("div");
  grid.className = "grdn-board";
  grid.style.setProperty("--size", String(size));

  const targetsByCell = new Map<string, Action>();
  for (const action of legalTargets) targetsByCell.set(key(action.row, action.col), action);

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const value = state.board[row][col];
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "grdn-cell";

      if (value === "OBSTACLE") {
        cell.classList.add("grdn-cell--obstacle");
        cell.setAttribute("aria-label", "연못");
        cell.disabled = true;
      } else if (value === "PLAYER_A" || value === "PLAYER_B") {
        const owner = value === "PLAYER_A" ? "A" : "B";
        cell.classList.add("grdn-cell--flower", owner === "A" ? "grdn-flower--a" : "grdn-flower--b");
        cell.setAttribute("aria-label", owner === "A" ? "장미 (플레이어 1)" : "수국 (플레이어 2)");
        const shape = document.createElement("span");
        shape.className = "grdn-flower-shape";
        cell.appendChild(shape);

        const clickable = interactive && owner === state.currentPlayer;
        cell.disabled = !clickable;
        if (clickable) cell.addEventListener("click", () => onCellClick(row, col));
      } else {
        cell.disabled = !interactive;
        cell.addEventListener("click", () => onCellClick(row, col));

        const target = targetsByCell.get(key(row, col));
        if (target) {
          cell.classList.add(target.type === "CLONE" ? "grdn-cell--clone-target" : "grdn-cell--jump-target");
          cell.setAttribute(
            "aria-label",
            target.type === "CLONE" ? `${row + 1}행 ${col + 1}열, 꽃피우기` : `${row + 1}행 ${col + 1}열, 씨앗 날리기`,
          );
          const icon = document.createElement("span");
          icon.className = "grdn-target-icon";
          cell.appendChild(icon);
        } else {
          cell.setAttribute("aria-label", `${row + 1}행 ${col + 1}열, 빈 화단`);
        }
      }

      if (selected && selected.row === row && selected.col === col) {
        cell.classList.add("grdn-cell--selected");
      }
      if (justConverted.has(key(row, col))) {
        cell.classList.add("grdn-cell--converted");
      }
      if (lastMove && lastMove.row === row && lastMove.col === col) {
        cell.classList.add("grdn-cell--last-move");
      }
      if (state.terrain[row][col] === "GREENHOUSE") {
        cell.classList.add("grdn-cell--greenhouse");
        cell.setAttribute("aria-label", `${cell.getAttribute("aria-label") ?? ""} — 온실 (물듦 면역)`);
      }

      grid.appendChild(cell);
    }
  }

  host.appendChild(grid);
}
