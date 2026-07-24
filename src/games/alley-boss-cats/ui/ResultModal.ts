import { computeMatchStats } from "../matchStats";
import { calculateFinalResult } from "../rules";
import type { GameState, Player } from "../types";
import { renderReplay } from "./Replay";

const PLAYER_NAME: Record<Player, string> = { A: "치즈냥", B: "고등어냥" };

export interface ResultModalOptions {
  state: GameState;
  matchStartedAt: number;
  onNewGame: () => void;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

export function renderResult(
  host: HTMLElement,
  { state, matchStartedAt, onNewGame }: ResultModalOptions,
): void {
  // Deliberately not an overlay: the moment a game ends is exactly when the
  // player wants to study the final position, and a centred dialog covers the
  // board it is reporting on. This sits below the board instead.
  const card = document.createElement("section");
  card.className = "abc-result-panel";

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

  if (state.winner) {
    const stats = computeMatchStats(state, state.winner, matchStartedAt);
    const statsBlock = document.createElement("div");
    statsBlock.className = "abc-result-stats";
    statsBlock.innerHTML = `
      <p>총 착수 수: ${stats.totalPlacements}수</p>
      <p>${winnerName}의 확보한 생활 구역: ${stats.winnerTerritory}칸</p>
      <p>${winnerName}의 가장 큰 생활 구역: ${stats.largestTerritoryPatch}칸</p>
      <p>포위 위협을 만든 횟수 — 치즈냥 ${stats.threatsCreated.A}회 / 고등어냥 ${stats.threatsCreated.B}회</p>
      <p>대국 시간: ${formatDuration(stats.durationMs)}</p>
    `;
    card.appendChild(statsBlock);
  }

  const actions = document.createElement("div");
  actions.className = "abc-result-actions";

  const replayBtn = document.createElement("button");
  replayBtn.type = "button";
  replayBtn.textContent = "기보 보기";
  replayBtn.addEventListener("click", () => renderReplay(document.body, state.moveHistory, () => {}));
  actions.appendChild(replayBtn);

  const newGameBtn = document.createElement("button");
  newGameBtn.type = "button";
  newGameBtn.textContent = "새 게임";
  newGameBtn.addEventListener("click", onNewGame);
  actions.appendChild(newGameBtn);

  card.appendChild(actions);
  host.appendChild(card);

  // Nudge it into view on small screens without yanking the board off-screen.
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
