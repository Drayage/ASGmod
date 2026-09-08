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
  wrap.className = "stp-mode-select";
  wrap.innerHTML = `
    <p class="stp-tagline">5×5 개울에 징검돌을 놓아 내 편끼리 이어 건너세요.<br>
    한 번에 돌 하나를 놓거나, 이미 쌓인 돌무더기를 들어 옮길 수 있어요. 맨 위 돌 색이 그 무더기의 주인입니다.<br>
    맨 처음 한 수는 상대의 평평한 돌을 대신 놓아줍니다.<br>2인 / 15~25분</p>
  `;

  const modeGroup = document.createElement("div");
  modeGroup.className = "stp-option-group";
  modeGroup.innerHTML = `<span class="stp-option-label">모드</span>`;
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
  difficultyGroup.className = "stp-option-group";
  difficultyGroup.innerHTML = `<span class="stp-option-label">AI 난이도</span>`;
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
  sideGroup.className = "stp-option-group";
  sideGroup.innerHTML = `<span class="stp-option-label">내 편</span>`;
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
  startBtn.className = "stp-primary-btn";
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
  wrapper.className = "stp-radio";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.checked = checked;
  input.addEventListener("change", onChange);
  wrapper.appendChild(input);
  wrapper.appendChild(document.createTextNode(label));
  return wrapper;
}
