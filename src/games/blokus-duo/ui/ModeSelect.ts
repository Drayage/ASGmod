import { DIFFICULTY_LABELS, type Difficulty } from "../ai";
import { createInitialState as createFourColorInitialState } from "../fourColor/rules";
import type { FourColorStartConfig } from "../fourColor/ui/GameScreen";
import { createInitialState } from "../rules";
import { loadSettings, saveSettings, type BoardMode, type Mode } from "../storage";
import type { GameState, Player } from "../types";

export interface StartConfig {
  mode: Mode;
  difficulty: Difficulty;
  humanSide: Player;
  initialState: GameState;
}

export type StartResult =
  | { boardMode: "DUO"; config: StartConfig }
  | { boardMode: "FOUR_COLOR"; config: FourColorStartConfig };

export function renderModeSelect(host: HTMLElement, onStart: (result: StartResult) => void): void {
  host.innerHTML = "";

  const settings = loadSettings();
  let boardMode: BoardMode = settings.lastBoardMode;
  let mode: Mode = settings.lastMode;
  let difficulty: Difficulty = settings.lastDifficulty;
  let humanSide: Player = settings.lastHumanSide;

  const wrap = document.createElement("div");
  wrap.className = "bkd-mode-select";

  const tagline = document.createElement("p");
  tagline.className = "bkd-tagline";
  wrap.appendChild(tagline);

  function updateTagline() {
    tagline.innerHTML =
      boardMode === "DUO"
        ? `14×14 마을 부지에서 각자 21개 조각으로 건물을 지어 나가는 2인 대결.<br>
           내 건물끼리는 꼭짓점으로만 이어야 하고 변으로 맞닿으면 안 돼요. 더 못 지으면 자동으로 차례를 넘깁니다.<br>2인 / 15~20분`
        : `20×20 넓은 마을을 2인이 각자 두 가지 색으로 나눠 짓는 설정.<br>
           P1은 블루+레드, P2는 옐로우+그린 — 턴은 블루→옐로우→레드→그린 순서로 자동 진행됩니다.<br>2인 / 30분 이상`;
  }

  const boardGroup = document.createElement("div");
  boardGroup.className = "bkd-option-group";
  boardGroup.innerHTML = `<span class="bkd-option-label">마을 크기</span>`;
  boardGroup.appendChild(
    radioButton("board", "작은 마을 (14×14, 2색)", boardMode === "DUO", () => {
      boardMode = "DUO";
      updateTagline();
    }),
  );
  boardGroup.appendChild(
    radioButton("board", "큰 마을 (20×20, 2인 2색씩)", boardMode === "FOUR_COLOR", () => {
      boardMode = "FOUR_COLOR";
      updateTagline();
    }),
  );
  wrap.appendChild(boardGroup);
  updateTagline();

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
    saveSettings({ ...loadSettings(), lastBoardMode: boardMode, lastMode: mode, lastDifficulty: difficulty, lastHumanSide: humanSide });
    if (boardMode === "DUO") {
      onStart({ boardMode: "DUO", config: { mode, difficulty, humanSide, initialState: createInitialState() } });
    } else {
      onStart({
        boardMode: "FOUR_COLOR",
        config: { mode, difficulty, humanSide, initialState: createFourColorInitialState() },
      });
    }
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
