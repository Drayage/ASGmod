import { loadSettings, saveSettings } from "../storage";

interface TutorialStep {
  title: string;
  body: string;
}

const STEPS: TutorialStep[] = [
  {
    title: "1. 꽃피우기",
    body: "가까운 화단(거리 1칸)에는 새 꽃을 피울 수 있어요. 기존 꽃은 그대로 남고, 꽃 수가 하나 늘어납니다.",
  },
  {
    title: "2. 씨앗 날리기",
    body: "두 칸 떨어진 화단에는 씨앗을 날릴 수 있어요. 이때 원래 자리의 꽃은 사라지고 새 자리로 옮겨갑니다.",
  },
  {
    title: "3. 주변 꽃 물들이기",
    body: "새로 놓인 꽃 주변 8칸에 있는 상대의 꽃은 모두 내 꽃으로 물듭니다.",
  },
  {
    title: "4. 승리 조건",
    body: "더 이상 아무도 움직일 수 없을 때, 꽃을 더 많이 가진 정원사가 승리합니다.",
  },
];

/** Renders the tutorial over `host` unconditionally — used for both the
 * automatic first-visit showing and the "튜토리얼 다시 보기" replay. Marks
 * it completed the moment it's shown, whether the player steps through it
 * or skips straight past. */
export function renderTutorial(host: HTMLElement, onDone: () => void): void {
  let index = 0;

  function finish() {
    saveSettings({ ...loadSettings(), tutorialCompleted: true });
    onDone();
  }

  function render() {
    host.innerHTML = "";

    const overlay = document.createElement("div");
    overlay.className = "grdn-overlay";

    const modal = document.createElement("div");
    modal.className = "grdn-modal";

    const step = STEPS[index];
    const counter = document.createElement("p");
    counter.className = "grdn-tutorial-counter";
    counter.textContent = `${index + 1} / ${STEPS.length}`;
    modal.appendChild(counter);

    const title = document.createElement("h2");
    title.textContent = step.title;
    modal.appendChild(title);

    const body = document.createElement("p");
    body.textContent = step.body;
    modal.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "grdn-tutorial-actions";

    const skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "grdn-link-btn";
    skipBtn.textContent = "건너뛰기";
    skipBtn.addEventListener("click", finish);
    actions.appendChild(skipBtn);

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "grdn-primary-btn";
    nextBtn.textContent = index === STEPS.length - 1 ? "시작하기" : "다음";
    nextBtn.addEventListener("click", () => {
      if (index === STEPS.length - 1) {
        finish();
      } else {
        index += 1;
        render();
      }
    });
    actions.appendChild(nextBtn);

    modal.appendChild(actions);
    overlay.appendChild(modal);
    host.appendChild(overlay);
  }

  render();
}

/** Shows the tutorial only if it hasn't been seen yet, otherwise calls
 * `onDone` immediately — the entry point `game.ts` uses on every mount, so
 * only a genuine first visit ever renders anything here. */
export function maybeShowTutorial(host: HTMLElement, onDone: () => void): void {
  if (loadSettings().tutorialCompleted) {
    onDone();
    return;
  }
  renderTutorial(host, onDone);
}
