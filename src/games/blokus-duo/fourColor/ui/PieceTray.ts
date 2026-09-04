import { PIECE_ORIENTATIONS, pieceSize, shapeBounds } from "../../pieces";
import type { PieceId } from "../../pieces";
import type { Coord } from "../../types";
import type { Color } from "../types";

export function renderShapeGrid(shape: Coord[], color: Color, cellPx: number): HTMLDivElement {
  const { height, width } = shapeBounds(shape);
  const grid = document.createElement("div");
  grid.className = "bkd-shape-grid";
  grid.style.gridTemplateColumns = `repeat(${width}, ${cellPx}px)`;
  grid.style.gridTemplateRows = `repeat(${height}, ${cellPx}px)`;

  const filled = new Set(shape.map((c) => `${c.row},${c.col}`));
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const cell = document.createElement("span");
      cell.className = filled.has(`${row},${col}`)
        ? `bkd-shape-cell bkd-shape-cell--${color.toLowerCase()}`
        : "bkd-shape-cell bkd-shape-cell--empty";
      grid.appendChild(cell);
    }
  }
  return grid;
}

export interface PieceTrayOptions {
  color: Color;
  label: string;
  remaining: PieceId[];
  interactive: boolean;
  selectedPieceId: PieceId | null;
  onSelectPiece: (pieceId: PieceId) => void;
}

export function renderPieceTray(host: HTMLElement, options: PieceTrayOptions): void {
  const { color, label, remaining, interactive, selectedPieceId, onSelectPiece } = options;

  const wrap = document.createElement("div");
  wrap.className = `bkd-tray bkd-tray--${color.toLowerCase()}`;

  const totalSquares = remaining.reduce((sum, id) => sum + pieceSize(id), 0);
  const heading = document.createElement("div");
  heading.className = "bkd-tray-heading";
  heading.textContent = `${label} · 남은 조각 ${remaining.length}개 (${totalSquares}칸)`;
  wrap.appendChild(heading);

  const row = document.createElement("div");
  row.className = "bkd-tray-row";
  if (remaining.length === 0) {
    const empty = document.createElement("span");
    empty.className = "bkd-tray-empty";
    empty.textContent = "모든 조각을 놓았습니다";
    row.appendChild(empty);
  }
  for (const pieceId of remaining) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bkd-tray-piece";
    if (selectedPieceId === pieceId) btn.classList.add("bkd-tray-piece--selected");
    btn.disabled = !interactive;
    btn.appendChild(renderShapeGrid(PIECE_ORIENTATIONS[pieceId][0], color, 5));
    if (interactive) btn.addEventListener("click", () => onSelectPiece(pieceId));
    row.appendChild(btn);
  }
  wrap.appendChild(row);

  host.appendChild(wrap);
}
