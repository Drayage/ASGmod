import type { AIAction, Difficulty } from "../ai";
import { getAIMove } from "../ai";
import { SearchAIClient, TIME_LIMIT_MS } from "../engine/aiWorkerClient";
import { applyMove, isLegalMove, isTerritoryCell, passTurn } from "../rules";
import * as sound from "../sound";
import { clearGame, loadSettings, recordResult, saveGame, saveRecord, type AITiming, type Mode } from "../storage";
import { opponent } from "../types";
import type { GameState, Player } from "../types";
import { renderBoard } from "./BoardView";
import { renderResult } from "./ResultModal";
import { renderRulesModal } from "./RulesModal";
import { renderSettingsPanel } from "./SettingsPanel";

export interface GameScreenConfig {
  mode: Mode;
  difficulty: Difficulty;
  humanSide: Player;
  initialState: GameState;
}

const PLAYER_NAME: Record<Player, string> = { A: "치즈냥", B: "고등어냥" };
const AI_THINK_DELAY_MS = 450;

export function mountGameScreen(
  container: HTMLElement,
  config: GameScreenConfig,
  onExit: () => void,
): () => void {
  let history: GameState[] = [config.initialState];
  let state = config.initialState;
  let shakeCell: { row: number; col: number } | null = null;
  let statusMessage = "";
  let aiThinking = false;
  let statsRecorded = false;
  let cancelled = false;
  let aiTimer: ReturnType<typeof setTimeout> | null = null;
  const searchAI = new SearchAIClient();
  const matchStartedAt = Date.now();
  // What each AI decision actually cost, against what it was allowed. Recorded
  // because a move that looks like a blunder and a move the engine never had
  // time to find are indistinguishable from the move list alone — a distinction
  // that took a long detour to work out the one time it mattered.
  const aiTimings: AITiming[] = [];

  const isAIMode = config.mode === "AI";
  const humanTurnNow = () => !isAIMode || state.currentPlayer === config.humanSide;

  const root = document.createElement("div");
  root.className = "abc-screen";
  container.appendChild(root);

  function persist() {
    if (state.winner) {
      clearGame();
    } else {
      saveGame({
        mode: config.mode,
        difficulty: config.difficulty,
        playerSide: config.humanSide,
        state,
      });
    }
  }

  function pushState(next: GameState) {
    history.push(next);
    state = next;
    persist();
  }

  function defaultStatus(): string {
    if (state.winner) return "";
    if (isAIMode && !humanTurnNow()) return `${PLAYER_NAME[state.currentPlayer]}가 골목을 살펴보는 중...`;
    return `${PLAYER_NAME[state.currentPlayer]} 차례입니다. 빈 골목을 선택하거나 쉬어가기를 누르세요.`;
  }

  function render() {
    root.innerHTML = "";

    const header = document.createElement("div");
    header.className = "abc-header";
    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "abc-link-btn";
    settingsBtn.textContent = "설정";
    settingsBtn.addEventListener("click", () => renderSettingsPanel(root));
    header.appendChild(settingsBtn);
    const rulesBtn = document.createElement("button");
    rulesBtn.type = "button";
    rulesBtn.className = "abc-link-btn";
    rulesBtn.textContent = "규칙 보기";
    rulesBtn.addEventListener("click", () => renderRulesModal(root));
    header.appendChild(rulesBtn);
    root.appendChild(header);

    root.appendChild(renderPlayerPanel("A"));

    const boardHost = document.createElement("div");
    boardHost.className = "abc-board-host";
    root.appendChild(boardHost);
    renderBoard(boardHost, {
      state,
      interactive: !state.winner && !aiThinking && humanTurnNow(),
      shakeCell,
      dangerLevel: loadSettings().dangerLevel,
      onCellClick: handleCellClick,
    });

    root.appendChild(renderPlayerPanel("B"));

    const status = document.createElement("p");
    status.className = "abc-status";
    status.textContent = statusMessage || defaultStatus();
    root.appendChild(status);

    root.appendChild(renderControls());

    if (state.winner) {
      renderResult(root, {
        state,
        matchStartedAt,
        onNewGame: () => onExit(),
      });
      if (!statsRecorded) {
        statsRecorded = true;
        const reason = state.winReason === "CAPTURE" ? "CAPTURE" : "TERRITORY";
        if (isAIMode) {
          recordResult({
            won: state.winner === config.humanSide,
            reason,
            difficulty: config.difficulty,
          });
        }
        // Every finished game is kept, local matches included — the record is
        // what makes a game reviewable afterwards, and which side was human
        // does not change that.
        saveRecord({
          mode: config.mode,
          difficulty: config.difficulty,
          playerSide: config.humanSide,
          winner: state.winner,
          winReason: reason,
          territoryA: state.territories.A.length,
          territoryB: state.territories.B.length,
          moveHistory: state.moveHistory,
          aiTimings,
        });
      }
    }
  }

  function renderPlayerPanel(player: Player): HTMLElement {
    const panel = document.createElement("div");
    panel.className = `abc-player-panel abc-player-panel--${player.toLowerCase()}`;
    if (state.currentPlayer === player && !state.winner) panel.classList.add("abc-player-panel--active");
    panel.innerHTML = `
      <span class="abc-player-name">${PLAYER_NAME[player]}</span>
      <span class="abc-player-stat">남은 고양이 ${state.remainingCats[player]}</span>
      <span class="abc-player-stat">생활 구역 ${state.territories[player].length}</span>
      ${state.currentPlayer === player && !state.winner ? '<span class="abc-player-turn">현재 차례</span>' : ""}
    `;
    return panel;
  }

  function renderControls(): HTMLElement {
    const controls = document.createElement("div");
    controls.className = "abc-controls";

    const passBtn = document.createElement("button");
    passBtn.type = "button";
    passBtn.textContent = "쉬어가기";
    passBtn.disabled = Boolean(state.winner) || aiThinking || !humanTurnNow();
    passBtn.addEventListener("click", handlePass);
    controls.appendChild(passBtn);

    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.textContent = "무르기";
    undoBtn.disabled = !canUndo() || aiThinking;
    undoBtn.addEventListener("click", handleUndo);
    controls.appendChild(undoBtn);

    const newGameBtn = document.createElement("button");
    newGameBtn.type = "button";
    newGameBtn.textContent = "새 게임";
    newGameBtn.addEventListener("click", () => {
      if (state.winner || window.confirm("현재 대국을 포기하고 새 게임을 시작할까요?")) {
        clearGame();
        onExit();
      }
    });
    controls.appendChild(newGameBtn);

    return controls;
  }

  function canUndo(): boolean {
    if (state.winner) return false;
    if (!isAIMode) return history.length > 1;
    return history.some((s, i) => i < history.length - 1 && s.currentPlayer === config.humanSide);
  }

  function handleUndo() {
    if (!canUndo() || aiThinking) return;
    if (!isAIMode) {
      history.pop();
      state = history[history.length - 1];
    } else {
      // Roll back to the most recent snapshot where it was the human's turn,
      // undoing both the player's move and the AI's reply together.
      let idx = history.length - 2;
      while (idx > 0 && history[idx].currentPlayer !== config.humanSide) idx -= 1;
      history = history.slice(0, idx + 1);
      state = history[history.length - 1];
    }
    shakeCell = null;
    statusMessage = "";
    persist();
    render();
  }

  function handlePass() {
    if (state.winner || aiThinking || !humanTurnNow()) return;
    sound.playPass();
    const next = passTurn(state);
    pushState(next);
    statusMessage = "";
    render();
    maybeTriggerAI();
  }

  function handleCellClick(row: number, col: number) {
    if (state.winner || aiThinking || !humanTurnNow()) return;
    const player = state.currentPlayer;

    if (!isLegalMove(state, row, col, player)) {
      shakeCell = { row, col };
      statusMessage = isTerritoryCell(state, row, col)
        ? "이미 확보된 생활 구역에는 들어갈 수 없습니다."
        : "이곳에 놓으면 도망길이 없어집니다.";
      sound.playIllegal();
      render();
      window.setTimeout(() => {
        if (cancelled) return;
        shakeCell = null;
        render();
      }, 300);
      return;
    }

    const territoryBefore = state.territories[player].length;
    const next = applyMove(state, row, col);
    sound.playPlace();
    if (next.winner === player && next.winReason === "CAPTURE") {
      sound.playCaptureWin();
    } else if (next.territories[player].length > territoryBefore) {
      sound.playTerritoryComplete();
    }
    statusMessage = "";
    pushState(next);
    render();
    maybeTriggerAI();
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      aiTimer = setTimeout(resolve, ms);
    });
  }

  async function decideAIAction(aiPlayer: Player): Promise<AIAction> {
    const turn = state.moveHistory.length + 1;
    const startedAt = Date.now();
    const note = (budgetMs: number, extra: { depth?: number; fallback?: true } = {}) => {
      aiTimings.push({ turn, elapsedMs: Date.now() - startedAt, budgetMs, ...extra });
    };

    if (config.difficulty !== "HARD" && config.difficulty !== "VERY_HARD") {
      const action = getAIMove(state, aiPlayer, config.difficulty);
      note(0);
      return action;
    }

    const budgetMs = TIME_LIMIT_MS[config.difficulty];
    try {
      const { action, depth } = await searchAI.requestMove(state, aiPlayer, config.difficulty);
      note(budgetMs, { depth });
      return action;
    } catch {
      // Worker unavailable or timed out — fall back rather than stall the game.
      const action = getAIMove(state, aiPlayer, "NORMAL");
      note(budgetMs, { fallback: true });
      return action;
    }
  }

  async function maybeTriggerAI() {
    if (!isAIMode || state.winner) return;
    if (state.currentPlayer === config.humanSide) return;

    aiThinking = true;
    render();

    const aiPlayer = opponent(config.humanSide);
    const startedAt = Date.now();
    const action = await decideAIAction(aiPlayer);
    if (cancelled) return;

    await delay(Math.max(0, AI_THINK_DELAY_MS - (Date.now() - startedAt)));
    if (cancelled) return;

    const territoryBefore = state.territories[aiPlayer].length;
    const next = action.type === "PASS" ? passTurn(state) : applyMove(state, action.row, action.col);

    if (action.type === "PASS") {
      sound.playPass();
    } else {
      sound.playPlace();
      if (next.winner === aiPlayer && next.winReason === "CAPTURE") sound.playCaptureWin();
      else if (next.territories[aiPlayer].length > territoryBefore) sound.playTerritoryComplete();
    }

    aiThinking = false;
    pushState(next);
    render();
    void maybeTriggerAI();
  }

  render();
  void maybeTriggerAI();

  return () => {
    cancelled = true;
    if (aiTimer) clearTimeout(aiTimer);
    searchAI.terminate();
  };
}
