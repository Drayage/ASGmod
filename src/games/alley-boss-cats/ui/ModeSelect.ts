import type { Difficulty } from "../ai";
import { createInitialState } from "../rules";
import { loadGame, type Mode } from "../storage";
import type { GameState, Player } from "../types";
import { renderSettingsPanel } from "./SettingsPanel";
import { renderStats } from "./StatsScreen";

export interface StartConfig {
  mode: Mode;
  difficulty: Difficulty;
  humanSide: Player;
  initialState: GameState;
}

export function renderModeSelect(host: HTMLElement, onStart: (config: StartConfig) => void): void {
  host.innerHTML = "";

  let mode: Mode = "AI";
  let difficulty: Difficulty = "NORMAL";
  let humanSide: Player = "A";

  const wrap = document.createElement("div");
  wrap.className = "abc-mode-select";

  wrap.innerHTML = `
    <p class="abc-tagline">골목을 둘러싸고 상대 고양이의 도망길을 막으세요.<br>2인 / 10~20분</p>
  `;

  const saved = loadGame();
  if (saved) {
    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "abc-primary-btn";
    resumeBtn.textContent = "이어하기";
    resumeBtn.addEventListener("click", () => {
      onStart({
        mode: saved.mode,
        difficulty: saved.difficulty,
        humanSide: saved.playerSide,
        initialState: saved.state,
      });
    });
    wrap.appendChild(resumeBtn);
  }

  const modeGroup = document.createElement("div");
  modeGroup.className = "abc-option-group";
  modeGroup.innerHTML = `<span class="abc-option-label">모드</span>`;
  const modeAI = radioButton("mode", "AI 대전", true, () => {
    mode = "AI";
    updateVisibility();
  });
  const modeLocal = radioButton("mode", "로컬 2인", false, () => {
    mode = "LOCAL";
    updateVisibility();
  });
  modeGroup.appendChild(modeAI);
  modeGroup.appendChild(modeLocal);
  wrap.appendChild(modeGroup);

  const difficultyGroup = document.createElement("div");
  difficultyGroup.className = "abc-option-group";
  difficultyGroup.innerHTML = `<span class="abc-option-label">AI 난이도</span>`;
  difficultyGroup.appendChild(
    radioButton("difficulty", "쉬움", false, () => {
      difficulty = "EASY";
    }),
  );
  difficultyGroup.appendChild(
    radioButton("difficulty", "보통", true, () => {
      difficulty = "NORMAL";
    }),
  );
  difficultyGroup.appendChild(
    radioButton("difficulty", "어려움", false, () => {
      difficulty = "HARD";
    }),
  );
  difficultyGroup.appendChild(
    radioButton("difficulty", "매우 어려움", false, () => {
      difficulty = "VERY_HARD";
    }),
  );
  wrap.appendChild(difficultyGroup);

  const sideGroup = document.createElement("div");
  sideGroup.className = "abc-option-group";
  sideGroup.innerHTML = `<span class="abc-option-label">내 무리</span>`;
  sideGroup.appendChild(
    radioButton("side", "치즈냥 (선공)", true, () => {
      humanSide = "A";
    }),
  );
  sideGroup.appendChild(
    radioButton("side", "고등어냥 (후공)", false, () => {
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
  startBtn.className = "abc-primary-btn";
  startBtn.textContent = "게임 시작";
  startBtn.addEventListener("click", () => {
    onStart({ mode, difficulty, humanSide, initialState: createInitialState() });
  });
  wrap.appendChild(startBtn);

  const linkRow = document.createElement("div");
  linkRow.className = "abc-mode-select-links";

  const statsBtn = document.createElement("button");
  statsBtn.type = "button";
  statsBtn.className = "abc-link-btn";
  statsBtn.textContent = "통계 보기";
  statsBtn.addEventListener("click", () => renderStats(wrap));
  linkRow.appendChild(statsBtn);

  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "abc-link-btn";
  settingsBtn.textContent = "설정";
  settingsBtn.addEventListener("click", () => renderSettingsPanel(wrap));
  linkRow.appendChild(settingsBtn);

  wrap.appendChild(linkRow);

  host.appendChild(wrap);
}

function radioButton(name: string, label: string, checked: boolean, onChange: () => void): HTMLLabelElement {
  const wrapper = document.createElement("label");
  wrapper.className = "abc-radio";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.checked = checked;
  input.addEventListener("change", onChange);
  wrapper.appendChild(input);
  wrapper.appendChild(document.createTextNode(label));
  return wrapper;
}
