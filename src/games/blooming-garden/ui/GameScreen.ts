import { getAIMove } from "../ai";
import { todayKey } from "../daily";
import { sendOnlineMove, subscribeOnlineRoom } from "../net/online";
import { getLegalMovesFrom, playMove } from "../rules";
import * as sound from "../sound";
import { recordDailyResult, recordResult } from "../storage";
import { cellOwner } from "../types";
import type { Action, Coord, GameState, Move, Player } from "../types";
import type { StartConfig } from "./ModeSelect";
import { renderBoard } from "./BoardView";
import { renderResultPanel } from "./ResultModal";
import { renderSettingsPanel } from "./SettingsPanel";

const PLAYER_NAME: Record<Player, string> = { A: "장미 정원사", B: "수국 정원사" };
const AI_THINK_DELAY_MS = 350;
/** How long the "just converted" flash stays on a cell. Longer than the CSS
 * animation itself (0.5s) so the animation always finishes before the class
 * is removed. Cleared by a timer rather than the next click, because
 * `render()` rebuilds the board from scratch on every call — a selection
 * click, the AI's "thinking" render, anything — and a fresh DOM node replays
 * its animation the moment the class lands on it, so the class has to stop
 * being applied on its own instead of waiting for the player to do something. */
const CONVERTED_FLASH_MS = 650;

function countFlowers(state: GameState): Record<Player, number> {
  const counts: Record<Player, number> = { A: 0, B: 0 };
  for (const row of state.board) {
    for (const cell of row) {
      const owner = cellOwner(cell);
      if (owner) counts[owner] += 1;
    }
  }
  return counts;
}

/** Cells whose owner flipped to `mover` between two boards, landing cell
 * excluded — that one is a placement, not a conversion. */
function convertedCells(before: GameState, after: GameState, mover: Player, landing: Coord): Set<string> {
  const converted = new Set<string>();
  const size = after.board.length;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (row === landing.row && col === landing.col) continue;
      if (before.board[row][col] === after.board[row][col]) continue;
      if (cellOwner(after.board[row][col]) === mover) converted.add(`${row},${col}`);
    }
  }
  return converted;
}

function lastMoveOf(state: GameState): Coord | null {
  const last = state.moveHistory[state.moveHistory.length - 1];
  return last ? { row: last.row, col: last.col } : null;
}

export function mountGameScreen(
  container: HTMLElement,
  config: StartConfig,
  onExit: () => void,
): () => void {
  let state = config.initialState;
  /** One entry per completed move (human or AI), `history[0]` the starting
   * position. Undo pops off this stack instead of replaying moveHistory
   * backwards, so it stays correct even though moves aren't reversible on
   * their own (a clone can't be un-added without knowing what it converted). */
  let history: GameState[] = [state];
  let selected: Coord | null = null;
  let legalTargets: Action[] = [];
  let justConverted = new Set<string>();
  let lastMove: Coord | null = null;
  let statusMessage = "";
  let aiThinking = false;
  let statsRecorded = false;
  let cancelled = false;
  let aiTimer: ReturnType<typeof setTimeout> | null = null;
  let convertedTimer: ReturnType<typeof setTimeout> | null = null;

  const isAIMode = config.mode === "AI";
  const isOnlineMode = config.mode === "ONLINE";
  const humanTurnNow = () => (!isAIMode && !isOnlineMode) || state.currentPlayer === config.humanSide;

  // Online-only state. `opponentOnline` starts optimistic — the room
  // subscription corrects it the moment its first snapshot arrives, well
  // before the player could plausibly notice a wrong initial value.
  let unsubscribeOnline: (() => void) | null = null;
  let opponentOnline = true;
  let onlineError: string | null = null;
  let onlineSubmitting = false;

  const root = document.createElement("div");
  root.className = "grdn-screen";
  container.appendChild(root);

  function defaultStatus(): string {
    if (state.winner) return "";
    if (isOnlineMode) {
      if (!opponentOnline) return "상대의 연결이 끊겼습니다. 다시 연결되기를 기다리는 중...";
      if (onlineSubmitting) return "이동을 전송하는 중...";
      if (!humanTurnNow()) return `${PLAYER_NAME[state.currentPlayer]}의 차례를 기다리는 중...`;
      return `${PLAYER_NAME[state.currentPlayer]} 차례입니다. 자신의 꽃을 선택하세요.`;
    }
    if (isAIMode && !humanTurnNow()) return `${PLAYER_NAME[state.currentPlayer]}가 화단을 살펴보는 중...`;
    return selected
      ? "이동할 화단을 선택하세요."
      : `${PLAYER_NAME[state.currentPlayer]} 차례입니다. 자신의 꽃을 선택하세요.`;
  }

  function render() {
    if (state.winner && !statsRecorded) {
      statsRecorded = true;
      recordResult({
        mode: config.mode,
        difficulty: config.difficulty,
        mapId: config.mapId,
        humanSide: config.humanSide,
        winner: state.winner,
      });
      if (config.isDaily) {
        recordDailyResult(todayKey(), { mapId: config.mapId, humanSide: config.humanSide, winner: state.winner });
      }
      if (state.winner === "DRAW") sound.playDraw();
      else if (config.mode === "LOCAL" || state.winner === config.humanSide) sound.playWin();
      else sound.playLose();
    }

    root.innerHTML = "";

    if (isOnlineMode && config.onlineCode) {
      const header = document.createElement("div");
      header.className = "grdn-header";
      const roomInfo = document.createElement("span");
      roomInfo.className = "grdn-room-info";
      roomInfo.textContent = `방 코드 ${config.onlineCode} · 상대 ${opponentOnline ? "연결됨" : "연결 끊김"}`;
      header.appendChild(roomInfo);
      root.appendChild(header);
    }

    root.appendChild(renderPlayerPanel("A"));

    const boardHost = document.createElement("div");
    boardHost.className = "grdn-board-host";
    root.appendChild(boardHost);
    renderBoard(boardHost, {
      state,
      interactive: !state.winner && !aiThinking && !onlineSubmitting && humanTurnNow(),
      selected,
      legalTargets,
      justConverted,
      lastMove,
      onCellClick: handleCellClick,
    });

    root.appendChild(renderPlayerPanel("B"));

    const status = document.createElement("p");
    status.className = "grdn-status";
    status.textContent = statusMessage || defaultStatus();
    root.appendChild(status);

    if (onlineError) {
      const errorLine = document.createElement("p");
      errorLine.className = "grdn-status grdn-online-error";
      errorLine.textContent = onlineError;
      root.appendChild(errorLine);
    }

    if (state.winner) {
      renderResultPanel(root, {
        state,
        onRestart: isOnlineMode || config.onTourNext ? null : restart,
        onNext: config.onTourNext ? () => config.onTourNext!(state.winner!) : null,
        onExit: exit,
      });
    } else {
      const controls = document.createElement("div");
      controls.className = "grdn-controls";
      // Undo has no meaning once a move has been relayed through the shared
      // room — there is no "unsend" for the opponent's copy of it.
      if (!isOnlineMode) {
        const undoBtn = document.createElement("button");
        undoBtn.type = "button";
        undoBtn.textContent = "되돌리기";
        undoBtn.disabled = !canUndo();
        undoBtn.addEventListener("click", undo);
        controls.appendChild(undoBtn);
      }
      const settingsBtn = document.createElement("button");
      settingsBtn.type = "button";
      settingsBtn.textContent = "설정";
      settingsBtn.addEventListener("click", () => renderSettingsPanel(root));
      controls.appendChild(settingsBtn);
      const exitBtn = document.createElement("button");
      exitBtn.type = "button";
      exitBtn.textContent = "메뉴로";
      exitBtn.addEventListener("click", exit);
      controls.appendChild(exitBtn);
      root.appendChild(controls);
    }
  }

  function renderPlayerPanel(player: Player): HTMLDivElement {
    const counts = countFlowers(state);
    const panel = document.createElement("div");
    panel.className = `grdn-player-panel grdn-player-panel--${player.toLowerCase()}`;
    if (state.currentPlayer === player && !state.winner) panel.classList.add("grdn-player-panel--active");
    panel.innerHTML = `
      <span class="grdn-player-name">${PLAYER_NAME[player]}</span>
      <span class="grdn-player-count">${counts[player]}송이</span>
    `;
    return panel;
  }

  function handleCellClick(row: number, col: number) {
    if (state.winner || aiThinking || onlineSubmitting || !humanTurnNow()) return;

    const player = state.currentPlayer;
    const clickedOwner = cellOwner(state.board[row][col]);

    if (clickedOwner === player) {
      if (selected && selected.row === row && selected.col === col) {
        clearSelection();
      } else {
        selected = { row, col };
        legalTargets = getLegalMovesFrom(state, row, col);
        statusMessage = "";
        sound.playSelect();
      }
      render();
      return;
    }

    if (!selected) return;

    const target = legalTargets.find((m) => m.row === row && m.col === col);
    if (!target) {
      clearSelection();
      render();
      return;
    }

    const action: Action =
      target.type === "CLONE"
        ? { type: "CLONE", row, col }
        : { type: "JUMP", fromRow: selected.row, fromCol: selected.col, row, col };

    if (isOnlineMode) {
      clearSelection();
      void submitOnlineMove(action);
      return;
    }
    commitMove(action);
  }

  function clearSelection() {
    selected = null;
    legalTargets = [];
  }

  function commitMove(action: Action) {
    const mover = state.currentPlayer;
    const before = state;
    const { state: after, skippedPlayers } = playMove(state, action);

    clearSelection();
    lastMove = { row: action.row, col: action.col };
    justConverted = convertedCells(before, after, mover, lastMove);
    state = after;
    history.push(state);

    if (action.type === "CLONE") sound.playClone();
    else sound.playJump();
    if (justConverted.size > 0) sound.playConvert(justConverted.size);
    if (skippedPlayers.length > 0) sound.playSkipTurn();

    statusMessage = skipMessage(skippedPlayers);
    render();

    if (convertedTimer) clearTimeout(convertedTimer);
    convertedTimer = setTimeout(() => {
      convertedTimer = null;
      if (cancelled) return;
      justConverted = new Set();
      render();
    }, CONVERTED_FLASH_MS);

    if (state.winner || !isAIMode) return;
    if (state.currentPlayer !== config.humanSide) scheduleAIMove();
  }

  function skipMessage(skippedPlayers: Player[]): string {
    if (skippedPlayers.length === 0) return "";
    const [skipped] = skippedPlayers;
    return `${PLAYER_NAME[skipped]}는 심을 수 있는 화단이 없어 이번 턴을 쉽니다.`;
  }

  function scheduleAIMove() {
    aiThinking = true;
    render();
    aiTimer = setTimeout(() => {
      aiTimer = null;
      if (cancelled || state.winner) return;
      const action = getAIMove(state, config.difficulty);
      aiThinking = false;
      commitMove(action);
    }, AI_THINK_DELAY_MS);
  }

  /**
   * Sends a locally-confirmed-legal move to the room. This never applies the
   * move to local state directly — `startOnlineSync`'s subscription is the
   * single path that drives `playMove`, for this player's own moves exactly
   * as much as the opponent's, so both clients replay the same ordered
   * history through the same pure reducer.
   */
  async function submitOnlineMove(action: Action) {
    if (!config.onlineCode) {
      onlineError = "온라인 방 코드가 없습니다.";
      render();
      return;
    }
    const move: Move = { ...action, turn: state.moveHistory.length, player: state.currentPlayer };
    onlineSubmitting = true;
    onlineError = null;
    render();
    try {
      await sendOnlineMove(config.onlineCode, move);
    } catch (err) {
      onlineError = err instanceof Error ? err.message : "이동을 전송하지 못했습니다.";
    } finally {
      onlineSubmitting = false;
      render();
    }
  }

  /**
   * Replays whatever new moves the room now has, in turn order, through the
   * same `playMove` reducer local/AI mode use — the room's move list is
   * simply this mode's event queue. A player with no legal move is never
   * relayed as a move: `playMove`'s own auto-skip logic is a pure function
   * of the board, so it resolves identically on both clients without either
   * side needing to send anything for it.
   *
   * Stops (rather than throwing past its caller) the moment a move fails to
   * apply, which given only client-side legality checks is this game's
   * fallback against a cheating or buggy opponent client: play halts with a
   * visible error instead of the two clients silently diverging.
   */
  function applyIncomingOnlineMoves(moves: Move[]) {
    const before = state;
    let lastApplied: Move | null = null;

    try {
      while (state.moveHistory.length < moves.length) {
        const move = moves[state.moveHistory.length];
        if (!move || move.turn !== state.moveHistory.length) break;
        state = playMove(state, move).state;
        history.push(state);
        lastApplied = move;
      }
    } catch {
      statusMessage = "상대의 이동을 적용할 수 없습니다. 게임 상태가 어긋났을 수 있습니다.";
      render();
      return;
    }

    if (lastApplied) {
      clearSelection();
      lastMove = { row: lastApplied.row, col: lastApplied.col };
      justConverted = convertedCells(before, state, lastApplied.player, lastMove);
      if (lastApplied.type === "CLONE") sound.playClone();
      else sound.playJump();
      if (justConverted.size > 0) sound.playConvert(justConverted.size);
      if (convertedTimer) clearTimeout(convertedTimer);
      convertedTimer = setTimeout(() => {
        convertedTimer = null;
        if (cancelled) return;
        justConverted = new Set();
        render();
      }, CONVERTED_FLASH_MS);
      statusMessage = "";
    }
    render();
  }

  function startOnlineSync() {
    if (!config.onlineCode) {
      onlineError = "온라인 방 코드가 없습니다.";
      render();
      return;
    }
    unsubscribeOnline = subscribeOnlineRoom(config.onlineCode, config.humanSide, (update) => {
      if (cancelled) return;
      opponentOnline = update.opponentOnline;
      applyIncomingOnlineMoves(update.moves);
    });
  }

  /** True once there's a position to go back to and nothing is mid-flight. */
  function canUndo(): boolean {
    if (isOnlineMode) return false;
    return history.length > 1 && !aiThinking && !state.winner;
  }

  function undo() {
    if (!canUndo()) return;
    if (aiTimer) {
      clearTimeout(aiTimer);
      aiTimer = null;
      aiThinking = false;
    }

    history.pop();
    if (isAIMode) {
      // Land back on the human's own last decision, not on the position
      // where the AI is about to answer it — otherwise "undo" would just
      // hand the turn straight back to the AI with nothing changed for
      // the player.
      while (history.length > 1 && history[history.length - 1].currentPlayer !== config.humanSide) {
        history.pop();
      }
    }
    state = history[history.length - 1];

    clearSelection();
    if (convertedTimer) clearTimeout(convertedTimer);
    convertedTimer = null;
    justConverted = new Set();
    lastMove = lastMoveOf(state);
    statusMessage = "";
    render();
  }

  function restart() {
    if (convertedTimer) clearTimeout(convertedTimer);
    convertedTimer = null;
    state = config.initialState;
    history = [state];
    clearSelection();
    justConverted = new Set();
    lastMove = null;
    statusMessage = "";
    aiThinking = false;
    statsRecorded = false;
    render();
    if (isAIMode && state.currentPlayer !== config.humanSide) {
      scheduleAIMove();
    }
  }

  function exit() {
    cancelled = true;
    if (aiTimer) clearTimeout(aiTimer);
    if (convertedTimer) clearTimeout(convertedTimer);
    unsubscribeOnline?.();
    onExit();
  }

  render();
  if (isOnlineMode) {
    startOnlineSync();
  } else if (isAIMode && state.currentPlayer !== config.humanSide) {
    scheduleAIMove();
  }

  return () => {
    cancelled = true;
    if (aiTimer) clearTimeout(aiTimer);
    if (convertedTimer) clearTimeout(convertedTimer);
    unsubscribeOnline?.();
    container.innerHTML = "";
  };
}
