import { stepOffsets } from "../rules";
import { BOARD_COLS, BOARD_ROWS, opponent } from "../types";
import type { Coord, GameState, HandPieceType, Piece, PieceType, Player } from "../types";
import { offsetPosition, PIECE_ICON_SVG } from "./pieceArt";

export type Selection = { kind: "BOARD"; coord: Coord } | { kind: "HAND"; pieceType: HandPieceType } | null;

export interface BoardRenderOptions {
  state: GameState;
  interactive: boolean;
  selected: Selection;
  /** Legal destination squares for the current selection — empty when
   * nothing is selected. */
  legalTargets: Coord[];
  lastMove: { from: Coord | null; to: Coord } | null;
  /** Whose seat the board is drawn from — this player's pieces render at
   * the bottom, moving "up" toward the opponent, regardless of whether
   * they're A or B. */
  viewpoint: Player;
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

/**
 * A piece tile: its animal icon, a small name caption, and — printed right
 * on the tile the same way a real Dōbutsu Shōgi piece is — a dot at each
 * compass position this piece can step to. Reads its own movement pattern
 * straight from `stepOffsets`, the same function `rules.ts` uses to decide
 * legal moves, so the dots can never drift out of sync with what the piece
 * actually does.
 */
function renderPiece(piece: Piece): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.className = `asg-piece asg-piece--${piece.owner.toLowerCase()} asg-piece--${piece.type.toLowerCase()}`;

  const icon = document.createElement("span");
  icon.className = "asg-piece-icon";
  icon.innerHTML = PIECE_ICON_SVG[piece.type];
  wrap.appendChild(icon);

  const label = document.createElement("span");
  label.className = "asg-piece-label";
  label.textContent = PIECE_LABEL[piece.type];
  wrap.appendChild(label);

  for (const [dr, dc] of stepOffsets(piece)) {
    const dot = document.createElement("span");
    dot.className = "asg-piece-dir";
    const pos = offsetPosition(dr, dc);
    dot.style.top = pos.top;
    dot.style.left = pos.left;
    wrap.appendChild(dot);
  }

  return wrap;
}

function renderHandIcon(type: PieceType): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.className = "asg-hand-icon";
  icon.innerHTML = PIECE_ICON_SVG[type];
  return icon;
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
    chip.appendChild(renderHandIcon(type));
    const label = document.createElement("span");
    label.textContent = count > 1 ? `${PIECE_LABEL[type]} ×${count}` : PIECE_LABEL[type];
    chip.appendChild(label);
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
  const { state, interactive, selected, legalTargets, lastMove, viewpoint, onCellClick, onHandPieceClick } = options;
  host.innerHTML = "";

  const targetKeys = new Set(legalTargets.map((c) => key(c.row, c.col)));

  // Always draw the viewer's own pieces at the bottom, moving "up" — flip
  // the visual row/column order (not the underlying coordinates, which
  // stay real board coordinates for click handlers and legality) when the
  // viewer is B, whose pieces otherwise sit at the top of the array.
  const flip = viewpoint === "B";
  const rowOrder = flip ? [...Array(BOARD_ROWS).keys()].reverse() : [...Array(BOARD_ROWS).keys()];
  const colOrder = flip ? [...Array(BOARD_COLS).keys()].reverse() : [...Array(BOARD_COLS).keys()];

  host.appendChild(renderHand(opponent(viewpoint), state, selected, interactive, onHandPieceClick));

  const grid = document.createElement("div");
  grid.className = "asg-board";
  grid.style.setProperty("--rows", String(BOARD_ROWS));
  grid.style.setProperty("--cols", String(BOARD_COLS));

  for (const row of rowOrder) {
    for (const col of colOrder) {
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

  host.appendChild(renderHand(viewpoint, state, selected, interactive, onHandPieceClick));
}
