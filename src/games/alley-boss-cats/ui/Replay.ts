import { applyMove, createInitialState, passTurn } from "../rules";
import type { GameState, Move, Player } from "../types";
import { renderBoard } from "./BoardView";

const AUTOPLAY_INTERVAL_MS = 700;

function replayToIndex(moveHistory: Move[], index: number): GameState {
  let state = createInitialState();
  for (let i = 0; i < index; i++) {
    const move = moveHistory[i];
    state = move.type === "PASS" ? passTurn(state) : applyMove(state, move.row, move.col);
  }
  return state;
}

const PLAYER_NAME: Record<Player, string> = { A: "치즈냥", B: "고등어냥" };

function describeMove(move: Move | undefined): string {
  if (!move) return "대국 시작";
  const who = PLAYER_NAME[move.player];
  if (move.type === "PASS") return `${move.turn}수 · ${who} 쉬어가기`;
  return `${move.turn}수 · ${who} ${move.row + 1}행 ${move.col + 1}열`;
}

export function renderReplay(host: HTMLElement, moveHistory: Move[], onClose: () => void): void {
  let index = moveHistory.length;
  let autoplayTimer: ReturnType<typeof setInterval> | null = null;

  const overlay = document.createElement("div");
  overlay.className = "abc-overlay";
  const card = document.createElement("div");
  card.className = "abc-modal abc-replay";
  overlay.appendChild(card);
  host.appendChild(overlay);

  function stopAutoplay() {
    if (autoplayTimer) {
      clearInterval(autoplayTimer);
      autoplayTimer = null;
    }
  }

  function goTo(nextIndex: number) {
    index = Math.max(0, Math.min(moveHistory.length, nextIndex));
    render();
  }

  function toggleAutoplay() {
    if (autoplayTimer) {
      stopAutoplay();
      render();
      return;
    }
    autoplayTimer = setInterval(() => {
      if (index >= moveHistory.length) {
        stopAutoplay();
        render();
        return;
      }
      index += 1;
      render();
    }, AUTOPLAY_INTERVAL_MS);
    render();
  }

  function button(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function render() {
    card.innerHTML = "";

    const title = document.createElement("h2");
    title.textContent = "기보 재생";
    card.appendChild(title);

    const counter = document.createElement("p");
    counter.className = "abc-replay-counter";
    counter.textContent = `${index} / ${moveHistory.length}수 — ${describeMove(moveHistory[index - 1])}`;
    card.appendChild(counter);

    const boardHost = document.createElement("div");
    boardHost.className = "abc-board-host";
    card.appendChild(boardHost);
    renderBoard(boardHost, {
      state: replayToIndex(moveHistory, index),
      interactive: false,
      shakeCell: null,
      onCellClick: () => {},
    });

    const controls = document.createElement("div");
    controls.className = "abc-replay-controls";
    controls.append(
      button("처음으로", () => {
        stopAutoplay();
        goTo(0);
      }, index === 0),
      button("이전 수", () => {
        stopAutoplay();
        goTo(index - 1);
      }, index === 0),
      button("다음 수", () => {
        stopAutoplay();
        goTo(index + 1);
      }, index === moveHistory.length),
      button("마지막으로", () => {
        stopAutoplay();
        goTo(moveHistory.length);
      }, index === moveHistory.length),
      button(autoplayTimer ? "정지" : "자동재생", toggleAutoplay),
    );
    card.appendChild(controls);

    card.appendChild(
      button("닫기", () => {
        stopAutoplay();
        overlay.remove();
        onClose();
      }),
    );
  }

  render();
}
