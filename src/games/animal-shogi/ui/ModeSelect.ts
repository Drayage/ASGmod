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
  wrap.className = "asg-mode-select";
  wrap.innerHTML = `
    <p class="asg-tagline">3×4 미니 장기. 사자를 잡거나 상대 진영 마지막 줄에 도착하면 승리.<br>2인 / 5분 내외</p>
  `;

  const modeGroup = document.createElement("div");
  modeGroup.className = "asg-option-group";
  modeGroup.innerHTML = `<span class="asg-option-label">모드</span>`;
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
  difficultyGroup.className = "asg-option-group";
  difficultyGroup.innerHTML = `<span class="asg-option-label">AI 난이도</span>`;
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
  sideGroup.className = "asg-option-group";
  sideGroup.innerHTML = `<span class="asg-option-label">내 편</span>`;
  sideGroup.appendChild(
    radioButton("side", "A (선공)", humanSide === "A", () => {
      humanSide = "A";
    }),
  );
  sideGroup.appendChild(
    radioButton("side", "B (후공)", humanSide === "B", () => {
      humanSide = "B";
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
  startBtn.className = "asg-primary-btn";
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
  wrapper.className = "asg-radio";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.checked = checked;
  input.addEventListener("change", onChange);
  wrapper.appendChild(input);
  wrapper.appendChild(document.createTextNode(label));
  return wrapper;
}
