import type { GameState, Player, WinReason } from "../types";

const PLAYER_NAME: Record<Player, string> = { A: "A", B: "B" };

const REASON_LABEL: Record<Exclude<WinReason, null>, string> = {
  CAPTURE: "사자를 잡았습니다",
  TRY: "사자가 상대 진영에 도착했습니다 (트라이)",
  NO_MOVES: "상대가 더 이상 움직일 수 없습니다",
};

export interface ResultPanelOptions {
  state: GameState;
  onRestart: () => void;
  onExit: () => void;
}

export function renderResultPanel(host: HTMLElement, options: ResultPanelOptions): void {
  const { state, onRestart, onExit } = options;
  if (!state.winner) return;

  const panel = document.createElement("div");
  panel.className = "asg-result-panel";

  const heading = document.createElement("h2");
  heading.textContent = `${PLAYER_NAME[state.winner]} 승리!`;
  panel.appendChild(heading);

  if (state.winReason) {
    const reason = document.createElement("p");
    reason.textContent = REASON_LABEL[state.winReason];
    panel.appendChild(reason);
  }

  const actions = document.createElement("div");
  actions.className = "asg-result-actions";

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
