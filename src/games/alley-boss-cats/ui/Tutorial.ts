import { loadSettings, saveSettings } from "../storage";

const STEPS = [
  "빈 골목을 눌러 고양이를 배치하세요.",
  "상하좌우로 붙은 고양이는 하나의 무리가 됩니다.\n대각선은 연결되지 않습니다.",
  "빈 골목을 완전히 둘러싸면 생활 구역이 됩니다.\n확보된 구역에는 누구도 들어갈 수 없습니다.",
  "상대 고양이 무리의 도망길을 모두 막으면 즉시 승리합니다.",
  "두 플레이어가 연속으로 쉬면 생활 구역을 계산합니다.\n선공 치즈냥은 3칸 이상 앞서야 승리합니다.",
];

export function maybeRenderTutorial(host: HTMLElement, onDone: () => void): void {
  if (loadSettings().tutorialCompleted) {
    onDone();
    return;
  }

  let step = 0;

  const overlay = document.createElement("div");
  overlay.className = "abc-overlay";

  const card = document.createElement("div");
  card.className = "abc-modal abc-tutorial";
  overlay.appendChild(card);
  host.appendChild(overlay);

  function finish() {
    saveSettings({ ...loadSettings(), tutorialCompleted: true });
    overlay.remove();
    onDone();
  }

  function render() {
    card.innerHTML = `
      <p class="abc-tutorial-step">${step + 1} / ${STEPS.length}</p>
      <p class="abc-tutorial-text">${STEPS[step].replace(/\n/g, "<br>")}</p>
    `;

    const actions = document.createElement("div");
    actions.className = "abc-tutorial-actions";

    const skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "abc-link-btn";
    skipBtn.textContent = "건너뛰기";
    skipBtn.addEventListener("click", finish);
    actions.appendChild(skipBtn);

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "abc-primary-btn";
    nextBtn.textContent = step === STEPS.length - 1 ? "시작하기" : "다음";
    nextBtn.addEventListener("click", () => {
      if (step === STEPS.length - 1) {
        finish();
      } else {
        step += 1;
        render();
      }
    });
    actions.appendChild(nextBtn);

    card.appendChild(actions);
  }

  render();
}
