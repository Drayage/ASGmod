import type { GameState } from "../types";

const PLAYER_NAME: Record<"P1" | "P2", string> = { P1: "P1 (블루+레드)", P2: "P2 (옐로우+그린)" };
const COLOR_LABEL: Record<"BLUE" | "YELLOW" | "RED" | "GREEN", string> = {
  BLUE: "블루",
  YELLOW: "옐로우",
  RED: "레드",
  GREEN: "그린",
};

export interface ResultPanelOptions {
  state: GameState;
  onRestart: () => void;
  onExit: () => void;
}

export function renderResultPanel(host: HTMLElement, options: ResultPanelOptions): void {
  const { state, onRestart, onExit } = options;
  const { winner, scores, colorScores } = state;
  if (!winner || !scores || !colorScores) return;

  const panel = document.createElement("div");
  panel.className = "bkd-result-panel";

  const heading = document.createElement("h2");
  heading.textContent = winner === "DRAW" ? "무승부!" : `${PLAYER_NAME[winner]} 승리!`;
  panel.appendChild(heading);

  const flavor = document.createElement("p");
  flavor.textContent = "마을이 완성되었습니다.";
  panel.appendChild(flavor);

  const score = document.createElement("p");
  score.textContent = `${PLAYER_NAME.P1} ${scores.P1}점 · ${PLAYER_NAME.P2} ${scores.P2}점`;
  panel.appendChild(score);

  const detail = document.createElement("p");
  detail.className = "bkd-result-detail";
  detail.textContent = (["BLUE", "YELLOW", "RED", "GREEN"] as const)
    .map((c) => `${COLOR_LABEL[c]} ${colorScores[c]}`)
    .join(" · ");
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
