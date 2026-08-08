import type { Difficulty } from "../ai";
import { createInitialState } from "../rules";
import { loadGame, loadSettings, saveSettings, type DangerLevel, type Mode } from "../storage";
import type { GameState, Player } from "../types";
import { renderRecords } from "./RecordsScreen";
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

  // Start from however the last game was set up. Re-picking "매우 어려움 / 고등어냥"
  // before every single game is pure friction, and the choice almost never
  // changes between sittings.
  const settings = loadSettings();
  let mode: Mode = settings.lastMode;
  let difficulty: Difficulty = settings.lastDifficulty;
  let humanSide: Player = settings.lastHumanSide;
  let dangerLevel: DangerLevel = settings.dangerLevel;

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
  const modeAI = radioButton("mode", "AI 대전", mode === "AI", () => {
    mode = "AI";
    updateVisibility();
  });
  const modeLocal = radioButton("mode", "로컬 2인", mode === "LOCAL", () => {
    mode = "LOCAL";
    updateVisibility();
  });
  modeGroup.appendChild(modeAI);
  modeGroup.appendChild(modeLocal);
  wrap.appendChild(modeGroup);

  const difficultyGroup = document.createElement("div");
  difficultyGroup.className = "abc-option-group";
  difficultyGroup.innerHTML = `<span class="abc-option-label">AI 난이도</span>`;
  const DIFFICULTIES: Array<[Difficulty, string]> = [
    ["EASY", "쉬움"],
    ["NORMAL", "보통"],
    ["HARD", "어려움"],
    ["VERY_HARD", "매우 어려움"],
  ];
  for (const [value, label] of DIFFICULTIES) {
    difficultyGroup.appendChild(
      radioButton("difficulty", label, difficulty === value, () => {
        difficulty = value;
      }),
    );
  }
  wrap.appendChild(difficultyGroup);

  const sideGroup = document.createElement("div");
  sideGroup.className = "abc-option-group";
  sideGroup.innerHTML = `<span class="abc-option-label">내 무리</span>`;
  sideGroup.appendChild(
    radioButton("side", "치즈냥 (선공)", humanSide === "A", () => {
      humanSide = "A";
    }),
  );
  sideGroup.appendChild(
    radioButton("side", "고등어냥 (후공)", humanSide === "B", () => {
      humanSide = "B";
    }),
  );
  wrap.appendChild(sideGroup);

  // Applies to both modes: reading danger is a matter of how much help the
  // player wants, not of who is sitting opposite.
  const dangerGroup = document.createElement("div");
  dangerGroup.className = "abc-option-group";
  dangerGroup.innerHTML = `<span class="abc-option-label">위기 감지</span>`;
  const DANGER_LEVELS: Array<[DangerLevel, string]> = [
    [0, "끄기"],
    [1, "1단계"],
    [2, "2단계"],
  ];
  for (const [value, label] of DANGER_LEVELS) {
    dangerGroup.appendChild(
      radioButton("danger", label, dangerLevel === value, () => {
        dangerLevel = value;
      }),
    );
  }
  const dangerHelp = document.createElement("p");
  dangerHelp.className = "abc-option-help";
  dangerHelp.textContent =
    "끄기: 표시 없음 · 1단계: 잡히기 직전인 고양이 · 2단계: 두면 바로 잡히는 빈칸까지";
  dangerGroup.appendChild(dangerHelp);
  wrap.appendChild(dangerGroup);

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
    saveSettings({
      ...loadSettings(),
      lastMode: mode,
      lastDifficulty: difficulty,
      lastHumanSide: humanSide,
      dangerLevel,
    });
    onStart({ mode, difficulty, humanSide, initialState: createInitialState() });
  });
  wrap.appendChild(startBtn);

  const linkRow = document.createElement("div");
  linkRow.className = "abc-mode-select-links";

  const recordsBtn = document.createElement("button");
  recordsBtn.type = "button";
  recordsBtn.className = "abc-link-btn";
  recordsBtn.textContent = "최근 기록";
  recordsBtn.addEventListener("click", () => renderRecords(wrap));
  linkRow.appendChild(recordsBtn);

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
