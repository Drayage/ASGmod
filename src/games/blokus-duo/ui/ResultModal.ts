import type { GameState } from "../types";

const PLAYER_NAME: Record<"P1" | "P2", string> = { P1: "P1", P2: "P2" };

export interface ResultPanelOptions {
  state: GameState;
  onRestart: () => void;
  onExit: () => void;
}

export function renderResultPanel(host: HTMLElement, options: ResultPanelOptions): void {
  const { state, onRestart, onExit } = options;
  if (!state.winner || !state.scores) return;

  const panel = document.createElement("div");
  panel.className = "bkd-result-panel";

  const heading = document.createElement("h2");
  heading.textContent = state.winner === "DRAW" ? "무승부!" : `${PLAYER_NAME[state.winner]} 승리!`;
  panel.appendChild(heading);

  const flavor = document.createElement("p");
  flavor.textContent = "마을이 완성되었습니다.";
  panel.appendChild(flavor);

  const score = document.createElement("p");
  score.textContent = `P1 ${state.scores.P1}점 · P2 ${state.scores.P2}점`;
  panel.appendChild(score);

  const detail = document.createElement("p");
  detail.className = "bkd-result-detail";
  const remainingP1 = state.remaining.P1.length;
  const remainingP2 = state.remaining.P2.length;
  detail.textContent = `남은 조각: P1 ${remainingP1}개 · P2 ${remainingP2}개`;
  panel.appendChild(detail);

  const actions = document.createElement("div");
  actions.className = "bkd-result-actions";

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
