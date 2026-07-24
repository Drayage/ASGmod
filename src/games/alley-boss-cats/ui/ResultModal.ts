import { calculateFinalResult } from "../rules";
import type { GameState, Player } from "../types";

const PLAYER_NAME: Record<Player, string> = { A: "치즈냥", B: "고등어냥" };

export interface ResultModalOptions {
  state: GameState;
  onNewGame: () => void;
}

export function renderResult(host: HTMLElement, { state, onNewGame }: ResultModalOptions): void {
  const overlay = document.createElement("div");
  overlay.className = "abc-overlay";

  const card = document.createElement("div");
  card.className = "abc-modal abc-result";

  const winnerName = state.winner ? PLAYER_NAME[state.winner] : "";

  if (state.winReason === "CAPTURE") {
    card.innerHTML = `
      <h2>도망길을 모두 막았습니다!</h2>
      <p>${winnerName} 무리가 골목을 장악했습니다.</p>
    `;
  } else {
    const result = calculateFinalResult(state);
    card.innerHTML = `
      <h2>생활 구역 판정</h2>
      <p>치즈냥 생활 구역: ${result.territoryA}칸</p>
      <p>고등어냥 생활 구역: ${result.territoryB}칸</p>
      <p class="abc-result-note">치즈냥은 3칸 이상 앞서야 승리합니다.</p>
      <p class="abc-result-winner">${winnerName} 무리가 골목대냥이 되었습니다!</p>
    `;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "새 게임";
  button.addEventListener("click", onNewGame);
  card.appendChild(button);

  overlay.appendChild(card);
  host.appendChild(overlay);
}
