import { countFlowers } from "../rules";
import type { GameState, Player } from "../types";

const PLAYER_NAME: Record<Player, string> = { A: "장미 정원사", B: "수국 정원사" };

export interface ResultPanelOptions {
  state: GameState;
  onRestart: () => void;
  onExit: () => void;
}

export function renderResultPanel(host: HTMLElement, options: ResultPanelOptions): void {
  const { state, onRestart, onExit } = options;
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

  const restartBtn = document.createElement("button");
  restartBtn.type = "button";
  restartBtn.textContent = "다시 시작";
  restartBtn.addEventListener("click", onRestart);
  actions.appendChild(restartBtn);

  const exitBtn = document.createElement("button");
  exitBtn.type = "button";
  exitBtn.textContent = "메뉴로";
  exitBtn.addEventListener("click", onExit);
  actions.appendChild(exitBtn);

  panel.appendChild(actions);
  host.appendChild(panel);
}
