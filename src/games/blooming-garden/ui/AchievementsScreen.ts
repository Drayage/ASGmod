import { ACHIEVEMENTS, unlockedCount } from "../achievements";
import { loadStats } from "../storage";

/** Renders the achievements screen over `host`'s current content. No
 * cleanup needed since navigating away just replaces `host`'s children. */
export function renderAchievements(host: HTMLElement, onBack: () => void): void {
  host.innerHTML = "";

  const stats = loadStats();
  const wrap = document.createElement("div");
  wrap.className = "grdn-achievements";

  const heading = document.createElement("h2");
  heading.textContent = `업적 (${unlockedCount(stats)}/${ACHIEVEMENTS.length})`;
  wrap.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "grdn-achievement-list";
  for (const achievement of ACHIEVEMENTS) {
    const unlocked = achievement.isUnlocked(stats);
    const item = document.createElement("li");
    item.className = `grdn-achievement${unlocked ? " grdn-achievement--unlocked" : ""}`;

    const title = document.createElement("span");
    title.className = "grdn-achievement-title";
    title.textContent = achievement.title;
    item.appendChild(title);

    const description = document.createElement("span");
    description.className = "grdn-achievement-description";
    description.textContent = achievement.description;
    item.appendChild(description);

    list.appendChild(item);
  }
  wrap.appendChild(list);

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.textContent = "돌아가기";
  backBtn.addEventListener("click", onBack);
  wrap.appendChild(backBtn);

  host.appendChild(wrap);
}
