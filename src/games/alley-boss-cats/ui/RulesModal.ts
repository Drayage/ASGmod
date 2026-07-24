const RULES_HTML = `
  <h2>규칙</h2>
  <h3>목표</h3>
  <p>상대보다 넓은 생활 구역을 확보하거나, 상대 고양이의 모든 도망길을 막으세요.</p>
  <h3>내 차례</h3>
  <p>내 차례에는 빈칸에 고양이 한 마리를 놓거나 쉬어갈 수 있습니다.</p>
  <h3>생활 구역</h3>
  <p>내 고양이와 담장, 공동 급식소로 빈 공간을 완전히 둘러싸면 생활 구역이 됩니다. 완성된 생활 구역에는 더 이상 고양이를 놓을 수 없습니다.</p>
  <h3>포위</h3>
  <p>상하좌우로 이어진 상대 고양이 무리에 빈 도망길이 하나도 남지 않으면 즉시 승리합니다.</p>
  <h3>종료</h3>
  <p>두 플레이어가 연속으로 쉬면 게임이 끝납니다. 치즈냥은 선공이므로 고등어냥보다 생활 구역이 3칸 이상 많아야 승리합니다.</p>
`;

export function renderRulesModal(host: HTMLElement): void {
  const overlay = document.createElement("div");
  overlay.className = "abc-overlay";

  const card = document.createElement("div");
  card.className = "abc-modal abc-rules";
  card.innerHTML = RULES_HTML;

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
