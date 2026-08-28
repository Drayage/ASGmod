import { hostOnlineRoom, joinOnlineRoom, subscribeOnlineRoom } from "../net/online";
import type { Player } from "../types";

export interface OnlineStartConfig {
  humanSide: Player;
  code: string;
}

/**
 * Host-or-join screen shown between mode-select and the game itself when
 * "온라인" is picked. Hosting waits here, watching the room's presence,
 * until the guest connects; joining hands off to the game screen right
 * away since the host — the room's creator — is already there by
 * definition. Either path calls `onReady` exactly once, with the room code
 * and which side this client plays.
 */
export function renderOnlineSetup(
  host: HTMLElement,
  onReady: (config: OnlineStartConfig) => void,
  onCancel: () => void,
): void {
  const wrap = document.createElement("div");
  wrap.className = "abc-mode-select abc-online-setup";

  let unsubscribe: (() => void) | null = null;
  let cancelled = false;

  function cleanup() {
    cancelled = true;
    unsubscribe?.();
    unsubscribe = null;
  }

  function mountWrap() {
    host.innerHTML = "";
    host.appendChild(wrap);
  }

  function backButton(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "abc-link-btn";
    btn.textContent = "돌아가기";
    btn.addEventListener("click", () => {
      cleanup();
      onCancel();
    });
    return btn;
  }

  function showError(message: string) {
    cleanup();
    wrap.innerHTML = "";
    const p = document.createElement("p");
    p.className = "abc-status abc-online-error";
    p.textContent = message;
    wrap.appendChild(p);
    wrap.appendChild(backButton());
    mountWrap();
  }

  function showChoice() {
    wrap.innerHTML = "";

    const title = document.createElement("p");
    title.className = "abc-tagline";
    title.textContent = "온라인 대전 — 방을 만들거나 코드로 참가하세요.";
    wrap.appendChild(title);

    const hostBtn = document.createElement("button");
    hostBtn.type = "button";
    hostBtn.className = "abc-primary-btn";
    hostBtn.textContent = "방 만들기";
    hostBtn.addEventListener("click", doHost);
    wrap.appendChild(hostBtn);

    const joinRow = document.createElement("div");
    joinRow.className = "abc-online-join-row";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "방 코드 입력";
    input.maxLength = 5;
    input.autocapitalize = "characters";
    input.className = "abc-online-code-input";
    const joinBtn = document.createElement("button");
    joinBtn.type = "button";
    joinBtn.className = "abc-primary-btn";
    joinBtn.textContent = "참가하기";
    joinBtn.addEventListener("click", () => doJoin(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doJoin(input.value);
    });
    joinRow.appendChild(input);
    joinRow.appendChild(joinBtn);
    wrap.appendChild(joinRow);

    wrap.appendChild(backButton());
    mountWrap();
  }

  async function doHost() {
    wrap.innerHTML = "<p>방을 만드는 중...</p>";
    mountWrap();
    try {
      const session = await hostOnlineRoom();
      if (cancelled) return;
      showWaiting(session.code, session.humanSide);
    } catch (err) {
      showError(err instanceof Error ? err.message : "방을 만들지 못했습니다.");
    }
  }

  async function doJoin(rawCode: string) {
    const code = rawCode.trim();
    if (!code) return;
    wrap.innerHTML = "<p>참가하는 중...</p>";
    mountWrap();
    try {
      const session = await joinOnlineRoom(code);
      if (cancelled) return;
      cleanup();
      onReady({ humanSide: session.humanSide, code: session.code });
    } catch (err) {
      showError(err instanceof Error ? err.message : "참가하지 못했습니다.");
    }
  }

  function showWaiting(code: string, humanSide: Player) {
    wrap.innerHTML = "";

    const codeLabel = document.createElement("p");
    codeLabel.className = "abc-online-code-display";
    codeLabel.textContent = code;
    wrap.appendChild(codeLabel);

    const hint = document.createElement("p");
    hint.className = "abc-tagline";
    hint.textContent = "이 코드를 상대에게 알려주세요.";
    wrap.appendChild(hint);

    const status = document.createElement("p");
    status.className = "abc-status";
    status.textContent = "상대가 참가하기를 기다리는 중...";
    wrap.appendChild(status);

    wrap.appendChild(backButton());
    mountWrap();

    unsubscribe = subscribeOnlineRoom(code, humanSide, (update) => {
      if (cancelled) return;
      if (update.opponentOnline) {
        cleanup();
        onReady({ humanSide, code });
      }
    });
  }

  showChoice();
}
