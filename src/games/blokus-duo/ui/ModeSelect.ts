import { DIFFICULTY_LABELS, type Difficulty } from "../ai";
import { createInitialState } from "../rules";
import { loadSettings, saveSettings, type Mode } from "../storage";
import type { GameState, Player } from "../types";

export interface StartConfig {
  mode: Mode;
  difficulty: Difficulty;
  humanSide: Player;
  initialState: GameState;
}

export function renderModeSelect(host: HTMLElement, onStart: (config: StartConfig) => void): void {
  host.innerHTML = "";

  const settings = loadSettings();
  let mode: Mode = settings.lastMode;
  let difficulty: Difficulty = settings.lastDifficulty;
  let humanSide: Player = settings.lastHumanSide;

  const wrap = document.createElement("div");
  wrap.className = "bkd-mode-select";
  wrap.innerHTML = `
    <p class="bkd-tagline">14×14 보드에서 각자 21개 조각을 놓는 2인용 블로커스.<br>
    자기 조각끼리는 꼭짓점만 맞닿아야 하고 변은 맞닿을 수 없어요. 더 못 놓으면 자동으로 차례를 넘깁니다.<br>2인 / 15~20분</p>
  `;

  const modeGroup = document.createElement("div");
  modeGroup.className = "bkd-option-group";
  modeGroup.innerHTML = `<span class="bkd-option-label">모드</span>`;
  modeGroup.appendChild(
    radioButton("mode", "AI 대전", mode === "AI", () => {
      mode = "AI";
      updateVisibility();
    }),
  );
  modeGroup.appendChild(
    radioButton("mode", "로컬 2인", mode === "LOCAL", () => {
      mode = "LOCAL";
      updateVisibility();
    }),
  );
  wrap.appendChild(modeGroup);

  const difficultyGroup = document.createElement("div");
  difficultyGroup.className = "bkd-option-group";
  difficultyGroup.innerHTML = `<span class="bkd-option-label">AI 난이도</span>`;
  const DIFFICULTIES: Difficulty[] = ["EASY", "NORMAL", "HARD"];
  for (const value of DIFFICULTIES) {
    difficultyGroup.appendChild(
      radioButton("difficulty", DIFFICULTY_LABELS[value], difficulty === value, () => {
        difficulty = value;
      }),
    );
  }
  wrap.appendChild(difficultyGroup);

  const sideGroup = document.createElement("div");
  sideGroup.className = "bkd-option-group";
  sideGroup.innerHTML = `<span class="bkd-option-label">내 편</span>`;
  sideGroup.appendChild(
    radioButton("side", "P1 (선공)", humanSide === "P1", () => {
      humanSide = "P1";
    }),
  );
  sideGroup.appendChild(
    radioButton("side", "P2 (후공)", humanSide === "P2", () => {
      humanSide = "P2";
    }),
  );
  wrap.appendChild(sideGroup);

  function updateVisibility() {
    const showAIOptions = mode === "AI";
    difficultyGroup.style.display = showAIOptions ? "" : "none";
    sideGroup.style.display = showAIOptions ? "" : "none";
  }
  updateVisibility();

  const startBtn = document.createElement("button");
  startBtn.type = "button";
  startBtn.className = "bkd-primary-btn";
  startBtn.textContent = "게임 시작";
  startBtn.addEventListener("click", () => {
    saveSettings({ ...loadSettings(), lastMode: mode, lastDifficulty: difficulty, lastHumanSide: humanSide });
    onStart({ mode, difficulty, humanSide, initialState: createInitialState() });
  });
  wrap.appendChild(startBtn);

  host.appendChild(wrap);
}

function radioButton(name: string, label: string, checked: boolean, onChange: () => void): HTMLLabelElement {
  const wrapper = document.createElement("label");
  wrapper.className = "bkd-radio";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.checked = checked;
  input.addEventListener("change", onChange);
  wrapper.appendChild(input);
  wrapper.appendChild(document.createTextNode(label));
  return wrapper;
}
