import { DIFFICULTY_LABELS, type Difficulty } from "../ai";
import { findMap } from "../maps";
import { loadStats } from "../storage";

const DIFFICULTIES: Difficulty[] = ["EASY", "NORMAL", "HARD"];

function mapLabel(mapId: string): string {
  return findMap(mapId)?.name ?? mapId;
}

/** Renders the stats screen over `host`'s current content. No cleanup
 * needed since navigating away just replaces `host`'s children again. */
export function renderStats(host: HTMLElement, onBack: () => void): void {
  host.innerHTML = "";

  const stats = loadStats();
  const wrap = document.createElement("div");
  wrap.className = "grdn-stats";

  const heading = document.createElement("h2");
  heading.textContent = "통계";
  wrap.appendChild(heading);

  if (stats.gamesPlayed === 0) {
    const empty = document.createElement("p");
    empty.className = "grdn-tagline";
    empty.textContent = "아직 플레이한 기록이 없습니다.";
    wrap.appendChild(empty);
  } else {
    const decided = stats.wins + stats.losses;
    const winRate = decided > 0 ? Math.round((stats.wins / decided) * 100) : null;

    addLine(wrap, `총 ${stats.gamesPlayed}게임 · ${stats.wins}승 ${stats.losses}패 ${stats.draws}무`);
    if (winRate !== null) addLine(wrap, `승률 ${winRate}% (로컬 2인 대전 제외)`);

    const difficultyLine = DIFFICULTIES.filter((d) => stats.winsByDifficulty[d] > 0)
      .map((d) => `${DIFFICULTY_LABELS[d]} ${stats.winsByDifficulty[d]}승`)
      .join(" · ");
    if (difficultyLine) {
      const subhead = document.createElement("p");
      subhead.className = "grdn-stats-subhead";
      subhead.textContent = "AI 난이도별";
      wrap.appendChild(subhead);
      addLine(wrap, difficultyLine);
    }

    const mapIds = Object.keys(stats.playsByMap).sort((a, b) => stats.playsByMap[b] - stats.playsByMap[a]);
    if (mapIds.length > 0) {
      const subhead = document.createElement("p");
      subhead.className = "grdn-stats-subhead";
      subhead.textContent = "맵별";
      wrap.appendChild(subhead);
      for (const mapId of mapIds) {
        const plays = stats.playsByMap[mapId];
        const wins = stats.winsByMap[mapId] ?? 0;
        addLine(wrap, `${mapLabel(mapId)} — ${plays}게임 · ${wins}승`);
      }
    }
  }

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.textContent = "돌아가기";
  backBtn.addEventListener("click", onBack);
  wrap.appendChild(backBtn);

  host.appendChild(wrap);
}

function addLine(host: HTMLElement, text: string): void {
  const p = document.createElement("p");
  p.textContent = text;
  host.appendChild(p);
}
