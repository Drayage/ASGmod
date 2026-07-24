import games, { findGame } from "./games/registry";
import type { GameCleanup } from "./shared/types";

const GAME_ROUTE = /^#\/game\/([a-z0-9-]+)$/;

let activeCleanup: GameCleanup | null = null;

function teardownActiveGame() {
  activeCleanup?.();
  activeCleanup = null;
}

function renderHub(root: HTMLElement) {
  root.innerHTML = "";

  const header = document.createElement("header");
  header.className = "hub-header";
  header.innerHTML = `
    <h1>추상 전략 게임 모음</h1>
    <p>규칙이 단순하고 운이 개입하지 않는 보드 게임들을 브라우저에서 바로.</p>
  `;
  root.appendChild(header);

  const list = document.createElement("div");
  list.className = "game-list";

  if (games.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "아직 등록된 게임이 없습니다. src/games/registry.ts에 추가하세요.";
    list.appendChild(empty);
  }

  for (const game of games) {
    const card = document.createElement("a");
    card.className = "game-card";
    card.href = `#/game/${game.id}`;
    card.innerHTML = `
      <h2>${game.title}</h2>
      <p>${game.description}</p>
      <span class="players">${playerLabel(game.minPlayers, game.maxPlayers)}</span>
    `;
    list.appendChild(card);
  }

  root.appendChild(list);
}

function playerLabel(min: number, max: number): string {
  return min === max ? `${min}인용` : `${min}~${max}인용`;
}

async function renderGame(root: HTMLElement, id: string) {
  root.innerHTML = "";

  const back = document.createElement("a");
  back.className = "back-link";
  back.href = "#/";
  back.textContent = "← 목록으로";
  root.appendChild(back);

  const meta = findGame(id);
  if (!meta) {
    const notFound = document.createElement("p");
    notFound.className = "empty-state";
    notFound.textContent = `"${id}" 게임을 찾을 수 없습니다.`;
    root.appendChild(notFound);
    return;
  }

  const title = document.createElement("h1");
  title.textContent = meta.title;
  root.appendChild(title);

  const stage = document.createElement("div");
  stage.className = "game-stage";
  root.appendChild(stage);

  const mod = await meta.load();
  const cleanup = mod.mount(stage);
  activeCleanup = cleanup ?? null;
}

export function initRouter(root: HTMLElement) {
  const handle = () => {
    teardownActiveGame();
    const hash = window.location.hash || "#/";
    const match = hash.match(GAME_ROUTE);
    if (match) {
      void renderGame(root, match[1]);
    } else {
      renderHub(root);
    }
  };

  window.addEventListener("hashchange", handle);
  handle();
}
