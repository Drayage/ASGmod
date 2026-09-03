import { DIFFICULTY_LABELS, type Difficulty } from "../ai";
import { DAILY_DIFFICULTY, dailyMapId, todayKey } from "../daily";
import { findMap, maps } from "../maps";
import { createInitialState } from "../rules";
import { getDailyResult, loadSettings, saveSettings, type Mode } from "../storage";
import type { GameState, Player } from "../types";
import { renderAchievements } from "./AchievementsScreen";
import { renderTutorial } from "./Tutorial";
import { renderOnlineSetup } from "./OnlineSetup";
import { renderStats } from "./StatsScreen";

export interface StartConfig {
  mode: Mode;
  difficulty: Difficulty;
  humanSide: Player;
  mapId: string;
  initialState: GameState;
  /** Room code to relay moves through. Only set when `mode === "ONLINE"`. */
  onlineCode?: string;
  /** True for a game started from the "오늘의 정원" button — GameScreen
   * also records its result under today's date key, alongside (not instead
   * of) the normal per-game stats recording every game already gets. */
  isDaily?: boolean;
  /** Set only for a leg of 정원 순회 (TourScreen supplies it, never
   * ModeSelect) — replaces the result panel's plain restart button with
   * "다음 맵", called with this leg's winner once the player is ready to
   * move on. */
  onTourNext?: (winner: Player | "DRAW") => void;
}

export function renderModeSelect(
  host: HTMLElement,
  onStart: (config: StartConfig) => void,
  onStartTour: (difficulty: Difficulty) => void,
): void {
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

  wrap.appendChild(renderDailyCard());

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
        () => renderModeSelect(host, onStart, onStartTour),
      );
      return;
    }
    onStart({ mode, difficulty, humanSide, mapId, initialState: createInitialState(mapId) });
  });
  wrap.appendChild(startBtn);

  const statsBtn = document.createElement("button");
  statsBtn.type = "button";
  statsBtn.className = "grdn-link-btn";
  statsBtn.textContent = "통계 보기";
  statsBtn.addEventListener("click", () => renderStats(wrap, () => renderModeSelect(host, onStart, onStartTour)));
  wrap.appendChild(statsBtn);

  const achievementsBtn = document.createElement("button");
  achievementsBtn.type = "button";
  achievementsBtn.className = "grdn-link-btn";
  achievementsBtn.textContent = "업적 보기";
  achievementsBtn.addEventListener("click", () => renderAchievements(wrap, () => renderModeSelect(host, onStart, onStartTour)));
  wrap.appendChild(achievementsBtn);

  const tourBtn = document.createElement("button");
  tourBtn.type = "button";
  tourBtn.className = "grdn-link-btn";
  tourBtn.textContent = "정원 순회 시작";
  tourBtn.addEventListener("click", () => onStartTour(difficulty));
  wrap.appendChild(tourBtn);

  const tutorialBtn = document.createElement("button");
  tutorialBtn.type = "button";
  tutorialBtn.className = "grdn-link-btn";
  tutorialBtn.textContent = "튜토리얼 다시 보기";
  tutorialBtn.addEventListener("click", () => renderTutorial(wrap, () => renderModeSelect(host, onStart, onStartTour)));
  wrap.appendChild(tutorialBtn);

  host.appendChild(wrap);

  function renderDailyCard(): HTMLDivElement {
    const dateKey = todayKey();
    const dailyMap = findMap(dailyMapId(dateKey));
    const result = getDailyResult(dateKey);

    const card = document.createElement("div");
    card.className = "grdn-daily-card";

    const title = document.createElement("p");
    title.className = "grdn-daily-title";
    title.textContent = "오늘의 정원";
    card.appendChild(title);

    const mapLine = document.createElement("p");
    mapLine.className = "grdn-daily-map";
    mapLine.textContent = dailyMap?.name ?? "";
    card.appendChild(mapLine);

    const status = document.createElement("p");
    status.className = "grdn-daily-status";
    status.textContent = result ? dailyResultLabel(result.winner) : "아직 도전하지 않았습니다.";
    card.appendChild(status);

    const dailyBtn = document.createElement("button");
    dailyBtn.type = "button";
    dailyBtn.className = "grdn-primary-btn";
    dailyBtn.textContent = result ? "다시 도전하기" : "오늘의 정원 도전";
    dailyBtn.addEventListener("click", () => {
      const dailyMapIdValue = dailyMapId(dateKey);
      onStart({
        mode: "AI",
        difficulty: DAILY_DIFFICULTY,
        humanSide: "A",
        mapId: dailyMapIdValue,
        initialState: createInitialState(dailyMapIdValue),
        isDaily: true,
      });
    });
    card.appendChild(dailyBtn);

    return card;
  }
}

function dailyResultLabel(winner: Player | "DRAW"): string {
  if (winner === "DRAW") return "오늘의 결과: 무승부";
  return winner === "A" ? "오늘의 결과: 승리!" : "오늘의 결과: 패배";
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
