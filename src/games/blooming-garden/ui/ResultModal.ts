import { countFlowers } from "../rules";
import type { GameState, Player } from "../types";

const PLAYER_NAME: Record<Player, string> = { A: "장미 정원사", B: "수국 정원사" };

export interface ResultPanelOptions {
  state: GameState;
  /** Null hides the restart button — for online mode (no rematch flow yet;
   * restarting locally would just desync this client from the shared room)
   * and for a 정원 순회 leg (its own "다음 맵" replaces plain restart). */
  onRestart: (() => void) | null;
  /** Set only for a 정원 순회 leg: advances to the next map (or the tour's
   * summary screen, on the last one) instead of restarting this one. */
  onNext?: (() => void) | null;
  onExit: () => void;
}

export function renderResultPanel(host: HTMLElement, options: ResultPanelOptions): void {
  const { state, onRestart, onNext, onExit } = options;
  if (!state.winner) return;

  const counts = countFlowers(state);
  const panel = document.createElement("div");
  panel.className = "grdn-result-panel";

  const heading = document.createElement("h2");
  heading.textContent = state.winner === "DRAW" ? "무승부!" : `${PLAYER_NAME[state.winner]}의 승리!`;
  panel.appendChild(heading);

  const scoreLine = document.createElement("p");
  scoreLine.textContent = `장미 ${counts.A}송이 · 수국 ${counts.B}송이`;
  panel.appendChild(scoreLine);

  const actions = document.createElement("div");
  actions.className = "grdn-result-actions";

  if (onNext) {
    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.textContent = "다음 맵";
    nextBtn.addEventListener("click", onNext);
    actions.appendChild(nextBtn);
  } else if (onRestart) {
    const restartBtn = document.createElement("button");
    restartBtn.type = "button";
    restartBtn.textContent = "다시 시작";
    restartBtn.addEventListener("click", onRestart);
    actions.appendChild(restartBtn);
  }

  const exitBtn = document.createElement("button");
  exitBtn.type = "button";
  exitBtn.textContent = "메뉴로";
  exitBtn.addEventListener("click", onExit);
  actions.appendChild(exitBtn);

  panel.appendChild(actions);
  host.appendChild(panel);
}
