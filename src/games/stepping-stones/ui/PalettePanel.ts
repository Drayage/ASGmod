import type { GameState, Player, StoneKind } from "../types";
import type { Selection } from "./BoardView";

const KIND_LABEL: Record<StoneKind, string> = { FLAT: "평돌", STANDING: "세운돌", CAP: "캡스톤" };

export interface PalettePanelOptions {
  state: GameState;
  player: Player;
  interactive: boolean;
  selection: Selection;
  onSelectKind: (kind: StoneKind) => void;
}

/** The three placeable stone kinds, plus (when a stack is selected for a
 * move) a stepper for how many stones to carry. */
export function renderPalette(host: HTMLElement, options: PalettePanelOptions): void {
  const { state, player, interactive, selection, onSelectKind } = options;

  const row = document.createElement("div");
  row.className = "stp-palette";

  const reserves = state.reserves[player];
  const kinds: StoneKind[] = ["FLAT", "STANDING", "CAP"];
  for (const kind of kinds) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `stp-palette-btn stp-palette-btn--${kind.toLowerCase()}`;
    const count = kind === "CAP" ? reserves.caps : reserves.flats;
    btn.innerHTML = `<span class="stp-palette-icon"></span><span>${KIND_LABEL[kind]} ${count}</span>`;
    const legal = interactive && count > 0 && legalKindForTurn(state, kind);
    btn.disabled = !legal;
    if (selection?.kind === "PLACE" && selection.stoneKind === kind) btn.classList.add("stp-palette-btn--selected");
    if (legal) btn.addEventListener("click", () => onSelectKind(kind));
    row.appendChild(btn);
  }

  host.appendChild(row);
}

function legalKindForTurn(state: GameState, kind: StoneKind): boolean {
  if (!state.hasPlayedFirstMove[state.currentPlayer]) return kind === "FLAT";
  return true;
}
