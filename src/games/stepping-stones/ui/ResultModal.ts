import { countFlats } from "../rules";
import type { GameState, Player } from "../types";

const PLAYER_NAME: Record<Player, string> = { P1: "P1", P2: "P2" };
const REASON_LABEL: Record<"ROAD" | "FLATS", string> = {
  ROAD: "징검다리를 완성했습니다",
  FLATS: "돌 개수로 승부가 갈렸습니다",
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
  panel.className = "stp-result-panel";

  const heading = document.createElement("h2");
  heading.textContent = state.winner === "DRAW" ? "무승부!" : `${PLAYER_NAME[state.winner]} 승리!`;
  panel.appendChild(heading);

  if (state.winReason) {
    const reason = document.createElement("p");
    reason.textContent = REASON_LABEL[state.winReason];
    panel.appendChild(reason);
  }

  const detail = document.createElement("p");
  detail.className = "stp-result-detail";
  detail.textContent = `P1 ${countFlats(state, "P1")}칸 · P2 ${countFlats(state, "P2")}칸`;
  panel.appendChild(detail);

  const actions = document.createElement("div");
  actions.className = "stp-result-actions";

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
