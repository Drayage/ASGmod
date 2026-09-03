import { BOARD_COLS, BOARD_ROWS } from "../types";
import type { Coord, GameState, HandPieceType, Piece, PieceType, Player } from "../types";

export type Selection = { kind: "BOARD"; coord: Coord } | { kind: "HAND"; pieceType: HandPieceType } | null;

export interface BoardRenderOptions {
  state: GameState;
  interactive: boolean;
  selected: Selection;
  /** Legal destination squares for the current selection — empty when
   * nothing is selected. */
  legalTargets: Coord[];
  lastMove: { from: Coord | null; to: Coord } | null;
  onCellClick: (row: number, col: number) => void;
  onHandPieceClick: (player: Player, pieceType: HandPieceType) => void;
}

const PIECE_LABEL: Record<PieceType, string> = {
  LION: "사자",
  GIRAFFE: "기린",
  ELEPHANT: "코끼리",
  CHICK: "병아리",
  HEN: "닭",
};

function key(row: number, col: number): string {
  return `${row},${col}`;
}

function renderPiece(piece: Piece): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `asg-piece asg-piece--${piece.owner.toLowerCase()} asg-piece--${piece.type.toLowerCase()}`;
  span.textContent = PIECE_LABEL[piece.type];
  return span;
}

function renderHand(
  player: Player,
  state: GameState,
  selected: Selection,
  interactive: boolean,
  onHandPieceClick: (player: Player, pieceType: HandPieceType) => void,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = `asg-hand asg-hand--${player.toLowerCase()}`;

  const counts = new Map<HandPieceType, number>();
  for (const type of state.hands[player]) counts.set(type, (counts.get(type) ?? 0) + 1);

  if (counts.size === 0) {
    const empty = document.createElement("span");
    empty.className = "asg-hand-empty";
    empty.textContent = "빈 손";
    row.appendChild(empty);
  }

  for (const [type, count] of counts) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `asg-hand-piece asg-piece--${player.toLowerCase()} asg-piece--${type.toLowerCase()}`;
    chip.textContent = count > 1 ? `${PIECE_LABEL[type]} ×${count}` : PIECE_LABEL[type];
    const clickable = interactive && player === state.currentPlayer;
    chip.disabled = !clickable;
    if (selected?.kind === "HAND" && selected.pieceType === type) {
      chip.classList.add("asg-hand-piece--selected");
    }
    if (clickable) chip.addEventListener("click", () => onHandPieceClick(player, type));
    row.appendChild(chip);
  }

  return row;
}

export function renderBoard(host: HTMLElement, options: BoardRenderOptions): void {
  const { state, interactive, selected, legalTargets, lastMove, onCellClick, onHandPieceClick } = options;
  host.innerHTML = "";

  const targetKeys = new Set(legalTargets.map((c) => key(c.row, c.col)));

  host.appendChild(renderHand("B", state, selected, interactive, onHandPieceClick));

  const grid = document.createElement("div");
  grid.className = "asg-board";
  grid.style.setProperty("--rows", String(BOARD_ROWS));
  grid.style.setProperty("--cols", String(BOARD_COLS));

  for (let row = 0; row < BOARD_ROWS; row++) {
    for (let col = 0; col < BOARD_COLS; col++) {
      const piece = state.board[row][col];
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "asg-cell";

      const isTarget = targetKeys.has(key(row, col));

      if (piece) {
        cell.appendChild(renderPiece(piece));
        // Clickable either to select one of the mover's own pieces, or to
        // capture an enemy piece sitting on a legal target square — without
        // the second case, a capture could never actually be played.
        const clickable = interactive && (piece.owner === state.currentPlayer || isTarget);
        cell.disabled = !clickable;
        cell.setAttribute("aria-label", `${row + 1}행 ${col + 1}열, ${piece.owner === "A" ? "A" : "B"} ${PIECE_LABEL[piece.type]}`);
        if (clickable) cell.addEventListener("click", () => onCellClick(row, col));
      } else {
        cell.disabled = !interactive;
        cell.setAttribute("aria-label", `${row + 1}행 ${col + 1}열, 빈 칸`);
        cell.addEventListener("click", () => onCellClick(row, col));
      }

      if (isTarget) {
        cell.classList.add("asg-cell--target");
        const marker = document.createElement("span");
        marker.className = "asg-target-marker";
        cell.appendChild(marker);
      }
      if (selected?.kind === "BOARD" && selected.coord.row === row && selected.coord.col === col) {
        cell.classList.add("asg-cell--selected");
      }
      if (lastMove && lastMove.to.row === row && lastMove.to.col === col) {
        cell.classList.add("asg-cell--last-move");
      }
      if (lastMove?.from && lastMove.from.row === row && lastMove.from.col === col) {
        cell.classList.add("asg-cell--last-from");
      }

      grid.appendChild(cell);
    }
  }
  host.appendChild(grid);

  host.appendChild(renderHand("A", state, selected, interactive, onHandPieceClick));
}
