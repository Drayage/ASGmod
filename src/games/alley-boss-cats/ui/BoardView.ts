import { BOARD_SIZE } from "../types";
import type { GameState } from "../types";

export interface BoardRenderOptions {
  state: GameState;
  /** Called for any EMPTY cell the player clicks — legality is decided by the caller. */
  onCellClick: (row: number, col: number) => void;
  /** When false, clicks are ignored (e.g. it's the AI's turn, or the game ended). */
  interactive: boolean;
  /** Cell to play the illegal-move shake animation on, if any. */
  shakeCell?: { row: number; col: number } | null;
}

function lastPlacedCell(state: GameState): { row: number; col: number } | null {
  const last = [...state.moveHistory].reverse().find((m) => m.type === "PLACE");
  return last && last.type === "PLACE" ? { row: last.row, col: last.col } : null;
}

function territoryOwner(state: GameState, row: number, col: number): "A" | "B" | null {
  if (state.territories.A.some((c) => c.row === row && c.col === col)) return "A";
  if (state.territories.B.some((c) => c.row === row && c.col === col)) return "B";
  return null;
}

export function renderBoard(host: HTMLElement, options: BoardRenderOptions): void {
  const { state, onCellClick, interactive, shakeCell } = options;
  host.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "abc-board";
  grid.style.setProperty("--size", String(BOARD_SIZE));

  const lastPlaced = lastPlacedCell(state);

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const value = state.board[row][col];
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "abc-cell";

      const owner = value === "EMPTY" ? territoryOwner(state, row, col) : null;

      if (value === "NEUTRAL") {
        cell.classList.add("abc-cell--neutral");
        cell.setAttribute("aria-label", "공동 급식소");
        cell.disabled = true;
      } else if (value === "PLAYER_A" || value === "PLAYER_B") {
        cell.classList.add("abc-cell--cat", value === "PLAYER_A" ? "abc-cat--a" : "abc-cat--b");
        cell.setAttribute("aria-label", value === "PLAYER_A" ? "치즈냥" : "고등어냥");
        cell.disabled = true;
        const face = document.createElement("span");
        face.className = "abc-cat-face";
        cell.appendChild(face);
      } else if (owner) {
        cell.classList.add("abc-cell--territory", owner === "A" ? "abc-territory--a" : "abc-territory--b");
        cell.setAttribute("aria-label", `${owner === "A" ? "치즈냥" : "고등어냥"} 생활 구역`);
        cell.disabled = true;
      } else {
        cell.setAttribute("aria-label", `${row + 1}행 ${col + 1}열`);
        cell.disabled = !interactive;
        cell.addEventListener("click", () => onCellClick(row, col));
      }

      if (lastPlaced && lastPlaced.row === row && lastPlaced.col === col) {
        cell.classList.add("abc-cell--last-move");
      }
      if (shakeCell && shakeCell.row === row && shakeCell.col === col) {
        cell.classList.add("abc-cell--shake");
      }

      grid.appendChild(cell);
    }
  }

  host.appendChild(grid);
}
