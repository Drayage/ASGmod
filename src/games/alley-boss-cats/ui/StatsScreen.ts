import { loadStats } from "../storage";

export function renderStats(host: HTMLElement): void {
  const overlay = document.createElement("div");
  overlay.className = "abc-overlay";

  const card = document.createElement("div");
  card.className = "abc-modal abc-stats";

  const stats = loadStats();
  const winRate = stats.gamesPlayed > 0 ? Math.round((stats.wins / stats.gamesPlayed) * 100) : 0;

  card.innerHTML = `
    <h2>통계</h2>
    <p>총 대국 수: ${stats.gamesPlayed}회</p>
    <p>승 / 패: ${stats.wins} / ${stats.losses} (승률 ${winRate}%)</p>
    <p>포위 승리: ${stats.captureWins}회 · 영토 승리: ${stats.territoryWins}회</p>
    <p class="abc-stats-subhead">난이도별 승리</p>
    <p>쉬움 ${stats.winsByDifficulty.EASY}회 · 보통 ${stats.winsByDifficulty.NORMAL}회<br>어려움 ${stats.winsByDifficulty.HARD}회 · 매우 어려움 ${stats.winsByDifficulty.VERY_HARD ?? 0}회</p>
  `;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "닫기";
  closeBtn.addEventListener("click", () => overlay.remove());
  card.appendChild(closeBtn);

  overlay.appendChild(card);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  host.appendChild(overlay);
}
