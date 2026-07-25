import { findEndangeredGroups } from "../groups";
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
  /**
   * Ring cats that the opponent could capture with a single move. Off by
   * default so the replay screen can show a position exactly as it was played.
   */
  showDanger?: boolean;
}

function coordKeys(cells: Iterable<{ row: number; col: number }>): Set<string> {
  const keys = new Set<string>();
  for (const { row, col } of cells) keys.add(`${row},${col}`);
  return keys;
}

/** Cats one enemy move from being surrounded, both colours at once — being
 * shown the danger to your own group is the point, and seeing it on theirs is
 * how you find the move that wins. */
function endangeredKeys(state: GameState): Set<string> {
  return coordKeys([
    ...findEndangeredGroups(state, "A").flat(),
    ...findEndangeredGroups(state, "B").flat(),
  ]);
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
  const { state, onCellClick, interactive, shakeCell, showDanger = false } = options;
  host.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "abc-board";
  grid.style.setProperty("--size", String(BOARD_SIZE));

  const lastPlaced = lastPlacedCell(state);
  // The group that ended the game outranks the danger ring: once it is
  // captured it is no longer "one move from" anything, it is the reason the
  // game is over, and it gets the stronger marking.
  const captured = coordKeys(state.capturedGroup ?? []);
  const endangered = showDanger && !state.winner ? endangeredKeys(state) : new Set<string>();

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

      const key = `${row},${col}`;
      if (captured.has(key)) {
        cell.classList.add("abc-cell--captured");
        cell.setAttribute("aria-label", `${cell.getAttribute("aria-label") ?? ""} — 도망길이 막힌 고양이`);
      } else if (endangered.has(key)) {
        cell.classList.add("abc-cell--danger");
        cell.setAttribute("aria-label", `${cell.getAttribute("aria-label") ?? ""} — 도망길이 하나 남음`);
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
