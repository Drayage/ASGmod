import { DIFFICULTY_LABELS, type Difficulty } from "../ai";
import { maps } from "../maps";
import { createInitialState } from "../rules";
import { loadSettings, saveSettings, type Mode } from "../storage";
import type { GameState, Player } from "../types";
import { renderOnlineSetup } from "./OnlineSetup";

export interface StartConfig {
  mode: Mode;
  difficulty: Difficulty;
  humanSide: Player;
  mapId: string;
  initialState: GameState;
  /** Room code to relay moves through. Only set when `mode === "ONLINE"`. */
  onlineCode?: string;
}

export function renderModeSelect(host: HTMLElement, onStart: (config: StartConfig) => void): void {
  host.innerHTML = "";

  const settings = loadSettings();
  let mode: Mode = settings.lastMode;
  let difficulty: Difficulty = settings.lastDifficulty;
  let humanSide: Player = settings.lastHumanSide;
  let mapId: string = settings.lastMapId;

  const wrap = document.createElement("div");
  wrap.className = "grdn-mode-select";
  wrap.innerHTML = `
    <p class="grdn-tagline">가까운 화단에는 꽃을 피우고, 먼 화단에는 씨앗을 날려<br>상대의 정원을 내 꽃으로 물들이세요.<br>2인 / 5~15분</p>
  `;

  const modeGroup = document.createElement("div");
  modeGroup.className = "grdn-option-group";
  modeGroup.innerHTML = `<span class="grdn-option-label">모드</span>`;
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
  modeGroup.appendChild(
    radioButton("mode", "온라인", mode === "ONLINE", () => {
      mode = "ONLINE";
      updateVisibility();
    }),
  );
  wrap.appendChild(modeGroup);

  const difficultyGroup = document.createElement("div");
  difficultyGroup.className = "grdn-option-group";
  difficultyGroup.innerHTML = `<span class="grdn-option-label">AI 난이도</span>`;
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
  sideGroup.className = "grdn-option-group";
  sideGroup.innerHTML = `<span class="grdn-option-label">내 정원사</span>`;
  sideGroup.appendChild(
    radioButton("side", "장미 (선공)", humanSide === "A", () => {
      humanSide = "A";
    }),
  );
  sideGroup.appendChild(
    radioButton("side", "수국 (후공)", humanSide === "B", () => {
      humanSide = "B";
    }),
  );
  wrap.appendChild(sideGroup);

  const mapGroup = document.createElement("div");
  mapGroup.className = "grdn-option-group";
  mapGroup.innerHTML = `<span class="grdn-option-label">맵</span>`;
  for (const map of maps) {
    mapGroup.appendChild(
      radioButton("map", map.name, mapId === map.id, () => {
        mapId = map.id;
      }),
    );
  }
  wrap.appendChild(mapGroup);

  function updateVisibility() {
    const showAIOptions = mode === "AI";
    difficultyGroup.style.display = showAIOptions ? "" : "none";
    sideGroup.style.display = showAIOptions ? "" : "none";
  }
  updateVisibility();

  const startBtn = document.createElement("button");
  startBtn.type = "button";
  startBtn.className = "grdn-primary-btn";
  startBtn.textContent = "게임 시작";
  startBtn.addEventListener("click", () => {
    saveSettings({
      ...loadSettings(),
      lastMode: mode,
      lastDifficulty: difficulty,
      lastHumanSide: humanSide,
      lastMapId: mapId,
    });
    if (mode === "ONLINE") {
      // humanSide and mapId are decided by whether this client hosts or
      // joins — OnlineSetup supplies both once a room is actually connected,
      // overriding whatever this screen's (now irrelevant, for a joiner)
      // side-effectless map pick was.
      renderOnlineSetup(
        wrap,
        mapId,
        (session) => {
          onStart({
            mode: "ONLINE",
            difficulty,
            humanSide: session.humanSide,
            mapId: session.mapId,
            initialState: createInitialState(session.mapId),
            onlineCode: session.code,
          });
        },
        () => renderModeSelect(host, onStart),
      );
      return;
    }
    onStart({ mode, difficulty, humanSide, mapId, initialState: createInitialState(mapId) });
  });
  wrap.appendChild(startBtn);

  host.appendChild(wrap);
}

function radioButton(name: string, label: string, checked: boolean, onChange: () => void): HTMLLabelElement {
  const wrapper = document.createElement("label");
  wrapper.className = "grdn-radio";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.checked = checked;
  input.addEventListener("change", onChange);
  wrapper.appendChild(input);
  wrapper.appendChild(document.createTextNode(label));
  return wrapper;
}
